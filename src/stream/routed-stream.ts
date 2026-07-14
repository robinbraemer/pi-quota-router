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
  ReservationLostError,
  startReservationHeartbeat,
} from "../routing/reservation-heartbeat.ts";
import { nextStreamEvent } from "./abortable-iterator.ts";
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
  | { kind: "unavailable"; reason: string };

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
  recordFailure(
    accountId: string,
    rejectedAccessToken: string | undefined,
    failure: FailureClass,
  ): Promise<void>;
  recordSuccess(accountId: string, sessionId?: string): void;
  release(leaseToken: string): Promise<void>;
  renew(leaseToken: string, ttlMs: number): Promise<boolean>;
  maxAttempts(): number;
}

class RouteUnavailableError extends Error {
  override readonly name = "RouteUnavailableError";

  constructor(reason: string) {
    super(
      reason === "no_eligible_accounts"
        ? "No Codex account is currently eligible; quota, usage data, or account health must recover before retrying"
        : reason === "manual_account_unavailable"
          ? "The selected Codex account is currently unavailable"
          : `No Codex account is available: ${reason}`,
    );
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
          lastFailure = new RouteUnavailableError(selection.reason);
          break;
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
            let latestPartial: AssistantMessage | undefined;
            try {
              const base = dependencies.baseStream(model, context, {
                ...options,
                apiKey: credential.accessToken,
                signal: heartbeat.signal,
              });
              const iterator = base[Symbol.asyncIterator]();
              while (true) {
                const next = await nextStreamEvent(iterator, heartbeat.signal);
                if (next.done) break;
                const event = next.value;
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

                if (event.type !== "done") {
                  latestPartial = event.partial;
                }
                if (pendingStart) {
                  output.push(pendingStart);
                  pendingStart = undefined;
                }
                if (event.type === "done") {
                  dependencies.recordSuccess(lease.accountId, options?.sessionId);
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
                await dependencies.recordFailure(lease.accountId, credential.accessToken, failure);
              }
              if (
                boundary.isReplaySafe() &&
                canRotateBeforeOutput(failure) &&
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
              const reason = options?.signal?.aborted ? "aborted" : "error";
              const safePartial =
                !boundary.isReplaySafe() &&
                (reason === "aborted" || error instanceof ReservationLostError)
                  ? latestPartial
                  : undefined;
              output.push(errorEvent(model, reason, error, safePartial));
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

      output.push(
        errorEvent(
          model,
          "error",
          lastFailure instanceof RouteUnavailableError
            ? lastFailure
            : new RouteUnavailableError("no_eligible_accounts"),
        ),
      );
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
  if (error instanceof ReservationLostError || error instanceof RouteUnavailableError) {
    return error.message;
  }
  return "No Codex account completed the request";
}
