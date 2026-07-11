import {
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
  type StreamFunction,
} from "@earendil-works/pi-ai";
import type { FreshCredential } from "../accounts/account-vault.ts";
import type { FailureClass } from "../recovery/failure-classifier.ts";
import {
  NoRecoverableAccountError,
  RecoveryWaitTimeoutError,
} from "../recovery/wait-for-recovery.ts";
import {
  ReservationLostError,
  startReservationHeartbeat,
} from "../routing/reservation-heartbeat.ts";
import type { AccountAffinityCoordinator } from "./account-affinity.ts";
import { ReplayBoundary } from "./replay-boundary.ts";
import { canRotateBeforeOutput } from "./stream-attempt.ts";

export interface RouteAttemptRequest {
  excludedAccountIds: ReadonlySet<string>;
  model: Model<"openai-codex-responses">;
  context: Context;
  options?: SimpleStreamOptions;
}

export interface RoutedLease {
  accountId: string;
  leaseToken: string;
  reservationTtlMs: number;
}

export type RouteSelection =
  | { kind: "selected"; lease: RoutedLease }
  | {
      kind: "unavailable";
      reason: string;
      recoverableAccountIds: string[];
      knownAccountIds: string[];
    };

export interface RoutedStreamDependencies {
  accountAffinity: AccountAffinityCoordinator;
  selectAndReserve(request: RouteAttemptRequest): Promise<RouteSelection>;
  getFreshCredential(accountId: string, signal?: AbortSignal): Promise<FreshCredential>;
  forceRefreshCredential(
    accountId: string,
    rejectedAccessToken: string,
    signal?: AbortSignal,
  ): Promise<FreshCredential>;
  baseStream: StreamFunction<"openai-codex-responses", SimpleStreamOptions>;
  classifyFailure(error: unknown): FailureClass;
  recordFailure(
    accountId: string,
    rejectedAccessToken: string | undefined,
    failure: FailureClass,
  ): Promise<void>;
  recordSuccess(accountId: string, sessionId?: string): void;
  release(leaseToken: string): Promise<void>;
  renew(leaseToken: string, ttlMs: number): Promise<boolean>;
  recoveryDeadline(): number;
  waitForRecovery(
    accountIds: readonly string[],
    knownAccountIds: readonly string[],
    deadline: number,
    signal?: AbortSignal,
  ): Promise<void>;
  maxAttempts(): number;
}

class RouteUnavailableError extends Error {
  override readonly name = "RouteUnavailableError";

  constructor(reason: string) {
    super(`No Codex account is available: ${reason}`);
  }
}

export function createRoutedStream(
  dependencies: RoutedStreamDependencies,
): StreamFunction<"openai-codex-responses", SimpleStreamOptions> {
  return (model, context, options) => {
    const output = createAssistantMessageEventStream();

    void (async () => {
      const affinity = await dependencies.accountAffinity.acquire(
        options?.sessionId,
        options?.signal,
      );
      let affinityReleased = false;
      const releaseAffinity = () => {
        if (affinityReleased) return;
        affinityReleased = true;
        affinity.release();
      };
      try {
        const excludedAccountIds = new Set<string>();
        let lastFailure: unknown;
        let recoveryDeadline: number | undefined;

        for (let attempt = 0; attempt < dependencies.maxAttempts(); ) {
          options?.signal?.throwIfAborted();
          const selection = await dependencies.selectAndReserve({
            excludedAccountIds,
            model,
            context,
            ...(options ? { options } : {}),
          });
          if (selection.kind === "unavailable") {
            if (selection.recoverableAccountIds.length === 0) {
              lastFailure = new RouteUnavailableError(selection.reason);
              break;
            }
            recoveryDeadline ??= dependencies.recoveryDeadline();
            await dependencies.waitForRecovery(
              selection.recoverableAccountIds,
              selection.knownAccountIds,
              recoveryDeadline,
              options?.signal,
            );
            excludedAccountIds.clear();
            continue;
          }

          const { lease } = selection;
          attempt += 1;
          let released = false;
          const release = async () => {
            if (!released) {
              released = true;
              await dependencies.release(lease.leaseToken);
            }
          };
          const heartbeat = startReservationHeartbeat({
            leaseToken: lease.leaseToken,
            ttlMs: lease.reservationTtlMs,
            renew: dependencies.renew,
            ...(options?.signal ? { signal: options.signal } : {}),
          });
          const boundary = new ReplayBoundary();
          let forceRefreshAttempted = false;

          try {
            let credential = await dependencies.getFreshCredential(
              lease.accountId,
              heartbeat.signal,
            );
            providerAttempt: while (true) {
              let pendingStart: Extract<AssistantMessageEvent, { type: "start" }> | undefined;
              try {
                affinity.beforeAttempt(lease.accountId);
                const base = dependencies.baseStream(model, context, {
                  ...options,
                  apiKey: credential.accessToken,
                  signal: heartbeat.signal,
                });

                for await (const event of base) {
                  if (event.type === "start") {
                    pendingStart = event;
                    continue;
                  }
                  boundary.observe(event);

                  if (event.type === "error") {
                    const classifiedInput = event.error.errorMessage ?? event.error;
                    const failure = dependencies.classifyFailure(classifiedInput);
                    lastFailure = classifiedInput;
                    if (
                      failure.kind === "auth-retry" &&
                      boundary.isReplaySafe() &&
                      !forceRefreshAttempted
                    ) {
                      forceRefreshAttempted = true;
                      credential = await dependencies.forceRefreshCredential(
                        lease.accountId,
                        credential.accessToken,
                        heartbeat.signal,
                      );
                      continue providerAttempt;
                    }
                    if (canRotateBeforeOutput(failure) && !options?.signal?.aborted) {
                      await dependencies.recordFailure(
                        lease.accountId,
                        credential.accessToken,
                        failure,
                      );
                    }
                    if (
                      boundary.isReplaySafe() &&
                      canRotateBeforeOutput(failure) &&
                      attempt < dependencies.maxAttempts() &&
                      !options?.signal?.aborted
                    ) {
                      excludedAccountIds.add(lease.accountId);
                      break providerAttempt;
                    }
                    await heartbeat.stop();
                    await release();
                    if (pendingStart) {
                      output.push(pendingStart);
                    }
                    output.push(
                      errorEvent(
                        model,
                        event.reason === "aborted" ? "aborted" : "error",
                        classifiedInput,
                        event.error,
                      ),
                    );
                    return;
                  }

                  if (pendingStart) {
                    output.push(pendingStart);
                    pendingStart = undefined;
                  }
                  if (event.type === "done") {
                    dependencies.recordSuccess(lease.accountId, options?.sessionId);
                    await heartbeat.stop();
                    await release();
                    releaseAffinity();
                    output.push(event);
                    return;
                  }
                  output.push(event);
                }

                lastFailure = new Error("Codex stream ended without a terminal event");
                await heartbeat.stop();
                await release();
                output.push(errorEvent(model, "error", lastFailure));
                return;
              } catch (error) {
                lastFailure = error;
                const failure = dependencies.classifyFailure(error);
                if (
                  failure.kind === "auth-retry" &&
                  boundary.isReplaySafe() &&
                  !forceRefreshAttempted &&
                  !options?.signal?.aborted
                ) {
                  forceRefreshAttempted = true;
                  credential = await dependencies.forceRefreshCredential(
                    lease.accountId,
                    credential.accessToken,
                    heartbeat.signal,
                  );
                  continue;
                }
                if (canRotateBeforeOutput(failure) && !options?.signal?.aborted) {
                  await dependencies.recordFailure(
                    lease.accountId,
                    credential.accessToken,
                    failure,
                  );
                }
                if (
                  boundary.isReplaySafe() &&
                  canRotateBeforeOutput(failure) &&
                  attempt < dependencies.maxAttempts() &&
                  !options?.signal?.aborted
                ) {
                  excludedAccountIds.add(lease.accountId);
                  break;
                }
                await heartbeat.stop();
                await release();
                if (pendingStart) {
                  output.push(pendingStart);
                }
                output.push(
                  errorEvent(model, options?.signal?.aborted ? "aborted" : "error", error),
                );
                return;
              }
            }
          } catch (error) {
            lastFailure = error;
            const failure = dependencies.classifyFailure(error);
            if (canRotateBeforeOutput(failure) && !options?.signal?.aborted) {
              await dependencies.recordFailure(lease.accountId, undefined, failure);
            }
            if (
              boundary.isReplaySafe() &&
              canRotateBeforeOutput(failure) &&
              attempt < dependencies.maxAttempts() &&
              !options?.signal?.aborted
            ) {
              excludedAccountIds.add(lease.accountId);
            } else {
              await heartbeat.stop();
              await release();
              output.push(errorEvent(model, options?.signal?.aborted ? "aborted" : "error", error));
              return;
            }
          } finally {
            await heartbeat.stop();
            await release();
          }
        }

        output.push(errorEvent(model, "error", lastFailure));
      } finally {
        releaseAffinity();
      }
    })().catch((error) => {
      output.push(errorEvent(model, options?.signal?.aborted ? "aborted" : "error", error));
    });

    return output;
  };
}

function errorEvent(
  model: Model<"openai-codex-responses">,
  reason: "aborted" | "error",
  error?: unknown,
  providerMessage?: AssistantMessage,
): Extract<AssistantMessageEvent, { type: "error" }> {
  const message: AssistantMessage = {
    role: "assistant",
    content: providerMessage?.content ?? [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: providerMessage?.usage ?? {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: reason,
    errorMessage: sanitizedErrorMessage(reason, error),
    timestamp: Date.now(),
  };
  return { type: "error", reason, error: message };
}

function sanitizedErrorMessage(reason: "aborted" | "error", error: unknown): string {
  if (reason === "aborted") {
    return error instanceof Error && error.message === "SIGINT"
      ? error.message
      : "The Codex request was cancelled";
  }
  if (
    error instanceof ReservationLostError ||
    error instanceof RecoveryWaitTimeoutError ||
    error instanceof NoRecoverableAccountError
  ) {
    return error.message;
  }
  return "No Codex account completed the request";
}
