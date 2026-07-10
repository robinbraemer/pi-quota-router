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
import { startReservationHeartbeat } from "../routing/reservation-heartbeat.ts";
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
    };

export interface RoutedStreamDependencies {
  selectAndReserve(request: RouteAttemptRequest): Promise<RouteSelection>;
  getFreshCredential(accountId: string, signal?: AbortSignal): Promise<FreshCredential>;
  forceRefreshCredential(
    accountId: string,
    rejectedAccessToken: string,
    signal?: AbortSignal,
  ): Promise<FreshCredential>;
  baseStream: StreamFunction<"openai-codex-responses", SimpleStreamOptions>;
  classifyFailure(error: unknown): FailureClass;
  recordFailure(accountId: string, failure: FailureClass): Promise<void>;
  release(leaseToken: string): Promise<void>;
  renew(leaseToken: string, ttlMs: number): Promise<boolean>;
  waitForRecovery(accountIds: readonly string[], signal?: AbortSignal): Promise<void>;
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
      const excludedAccountIds = new Set<string>();
      let lastFailure: unknown;

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
          await dependencies.waitForRecovery(selection.recoverableAccountIds, options?.signal);
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
          let credential = await dependencies.getFreshCredential(lease.accountId, heartbeat.signal);
          providerAttempt: while (true) {
            let pendingStart: Extract<AssistantMessageEvent, { type: "start" }> | undefined;
            try {
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
                    await dependencies.recordFailure(lease.accountId, failure);
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
                  output.push(event);
                  return;
                }

                if (pendingStart) {
                  output.push(pendingStart);
                  pendingStart = undefined;
                }
                if (event.type === "done") {
                  await heartbeat.stop();
                  await release();
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
                await dependencies.recordFailure(lease.accountId, failure);
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
              output.push(errorEvent(model, options?.signal?.aborted ? "aborted" : "error", error));
              return;
            }
          }
        } catch (error) {
          lastFailure = error;
          const failure = dependencies.classifyFailure(error);
          if (canRotateBeforeOutput(failure) && !options?.signal?.aborted) {
            await dependencies.recordFailure(lease.accountId, failure);
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
): Extract<AssistantMessageEvent, { type: "error" }> {
  const message: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: reason,
    errorMessage: error instanceof Error ? error.message : "No Codex account completed the request",
    timestamp: Date.now(),
  };
  return { type: "error", reason, error: message };
}
