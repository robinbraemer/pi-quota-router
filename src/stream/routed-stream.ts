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
import { ReplayBoundary } from "./replay-boundary.ts";
import { canRotateBeforeOutput } from "./stream-attempt.ts";
import {
  nextStreamEvent,
  resolveStreamSilenceTimeoutMs,
  StreamSilenceTimeoutError,
  type StreamTimers,
  systemStreamTimers,
} from "./stream-silence.ts";

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
  timers?: StreamTimers;
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
      const streamSilenceTimeoutMs = resolveStreamSilenceTimeoutMs(options?.timeoutMs);
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
          if (!(lastFailure instanceof StreamSilenceTimeoutError)) {
            lastFailure = new RouteUnavailableError(selection.reason);
          }
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
            const deadline = createStreamDeadline({
              heartbeatSignal: heartbeat.signal,
              ...(options?.signal ? { externalSignal: options.signal } : {}),
              timeoutMs: streamSilenceTimeoutMs,
              timers: dependencies.timers ?? systemStreamTimers,
            });
            try {
              deadline.arm("pre-output");
              const base = dependencies.baseStream(model, context, {
                ...options,
                apiKey: credential.accessToken,
                signal: deadline.signal,
                timeoutMs: streamSilenceTimeoutMs,
              });
              const iterator = base[Symbol.asyncIterator]();
              while (true) {
                const next = await nextStreamEvent(iterator, deadline.signal);
                if (next.done) break;
                const event = next.value;
                if (event.type === "start") {
                  pendingStart = event;
                  deadline.arm("pre-output");
                  continue;
                }
                boundary.observe(event);

                if (event.type === "error") {
                  deadline.stop();
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
                  deadline.arm(boundary.isReplaySafe() ? "pre-output" : "post-output");
                }
                if (pendingStart) {
                  output.push(pendingStart);
                  pendingStart = undefined;
                }
                if (event.type === "done") {
                  deadline.stop();
                  dependencies.recordSuccess(lease.accountId, options?.sessionId);
                  await heartbeat.stop();
                  await release();
                  output.push(event);
                  return;
                }
                output.push(event);
              }

              deadline.stop();
              lastFailure = new Error("Codex stream ended without a terminal event");
              await heartbeat.stop();
              await release();
              output.push(errorEvent(model, "error", lastFailure));
              return;
            } catch (error) {
              deadline.stop();
              lastFailure = error;
              if (error instanceof StreamSilenceTimeoutError && !options?.signal?.aborted) {
                if (boundary.isReplaySafe()) {
                  excludedAccountIds.add(lease.accountId);
                  break;
                }
                await heartbeat.stop();
                await release();
                if (pendingStart) {
                  output.push(pendingStart);
                }
                output.push(errorEvent(model, "error", error));
                return;
              }
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
              output.push(errorEvent(model, options?.signal?.aborted ? "aborted" : "error", error));
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
          lastFailure instanceof StreamSilenceTimeoutError
            ? lastFailure
            : lastFailure instanceof RouteUnavailableError
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
  if (
    error instanceof ReservationLostError ||
    error instanceof RouteUnavailableError ||
    error instanceof StreamSilenceTimeoutError
  ) {
    return error.message;
  }
  return "No Codex account completed the request";
}

function createStreamDeadline(options: {
  heartbeatSignal: AbortSignal;
  externalSignal?: AbortSignal;
  timeoutMs: number;
  timers: StreamTimers;
}): {
  signal: AbortSignal;
  arm(phase: "pre-output" | "post-output"): void;
  stop(): void;
} {
  const timeout = new AbortController();
  const signal = AbortSignal.any([options.heartbeatSignal, timeout.signal]);
  let timer: ReturnType<StreamTimers["setTimeout"]> | undefined;
  const stop = () => {
    timer?.clear();
    timer = undefined;
  };
  return {
    signal,
    arm(phase) {
      stop();
      timer = options.timers.setTimeout(() => {
        if (options.externalSignal?.aborted || options.heartbeatSignal.aborted) return;
        timeout.abort(new StreamSilenceTimeoutError(phase));
      }, options.timeoutMs);
    },
    stop,
  };
}
