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
}

export interface RoutedStreamDependencies {
  selectAndReserve(request: RouteAttemptRequest): Promise<RoutedLease | undefined>;
  getFreshCredential(accountId: string, signal?: AbortSignal): Promise<FreshCredential>;
  baseStream: StreamFunction<"openai-codex-responses", SimpleStreamOptions>;
  classifyFailure(error: unknown): FailureClass;
  recordFailure(accountId: string, failure: FailureClass): Promise<void>;
  release(leaseToken: string): Promise<void>;
  waitForRecovery(signal?: AbortSignal): Promise<void>;
  maxAttempts: number;
}

export function createRoutedStream(
  dependencies: RoutedStreamDependencies,
): StreamFunction<"openai-codex-responses", SimpleStreamOptions> {
  return (model, context, options) => {
    const output = createAssistantMessageEventStream();

    void (async () => {
      const excludedAccountIds = new Set<string>();
      let lastFailure: unknown;

      for (let attempt = 0; attempt < dependencies.maxAttempts; ) {
        options?.signal?.throwIfAborted();
        const lease = await dependencies.selectAndReserve({
          excludedAccountIds,
          model,
          context,
          ...(options ? { options } : {}),
        });
        if (!lease) {
          await dependencies.waitForRecovery(options?.signal);
          excludedAccountIds.clear();
          continue;
        }

        attempt += 1;
        let released = false;
        const release = async () => {
          if (!released) {
            released = true;
            await dependencies.release(lease.leaseToken);
          }
        };

        try {
          const credential = await dependencies.getFreshCredential(
            lease.accountId,
            options?.signal,
          );
          const boundary = new ReplayBoundary();
          let pendingStart: Extract<AssistantMessageEvent, { type: "start" }> | undefined;
          const base = dependencies.baseStream(model, context, {
            ...options,
            apiKey: credential.accessToken,
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
                boundary.isReplaySafe() &&
                canRotateBeforeOutput(failure) &&
                attempt < dependencies.maxAttempts
              ) {
                await dependencies.recordFailure(lease.accountId, failure);
                excludedAccountIds.add(lease.accountId);
                break;
              }
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
            output.push(event);
            if (event.type === "done") {
              return;
            }
          }
        } catch (error) {
          lastFailure = error;
          const failure = dependencies.classifyFailure(error);
          if (
            canRotateBeforeOutput(failure) &&
            attempt < dependencies.maxAttempts &&
            !options?.signal?.aborted
          ) {
            await dependencies.recordFailure(lease.accountId, failure);
            excludedAccountIds.add(lease.accountId);
            continue;
          }
          output.push(errorEvent(model, options?.signal?.aborted ? "aborted" : "error"));
          return;
        } finally {
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
