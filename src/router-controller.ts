import { randomUUID } from "node:crypto";
import type {
  Context,
  Model,
  SimpleStreamOptions,
  StreamFunction,
  ThinkingLevel,
} from "@earendil-works/pi-ai";
import { OPENAI_CODEX_MODELS } from "@earendil-works/pi-ai/providers/openai-codex.models";
import type { AccountVault, CodexOAuthClient } from "./accounts/account-vault.ts";
import { createAccountVault } from "./accounts/account-vault.ts";
import { defaultConfig } from "./config.ts";
import { createPrimingController } from "./priming/priming-controller.ts";
import type { ProviderController } from "./provider.ts";
import { classifyFailure, type FailureClass } from "./recovery/failure-classifier.ts";
import { blockFromFailure } from "./recovery/recovery-state.ts";
import { waitForRecovery } from "./recovery/wait-for-recovery.ts";
import { createReservationStore } from "./routing/reservation-store.ts";
import { selectAndReserve } from "./routing/select-and-reserve.ts";
import { createAtomicJsonStore } from "./storage/atomic-json-store.ts";
import type { RouterPaths } from "./storage/paths.ts";
import {
  type AccountVaultFile,
  AccountVaultFileSchema,
  defaultRuntimeState,
  RouterConfigSchema,
  type RuntimeStateFile,
  RuntimeStateFileSchema,
} from "./storage/schemas.ts";
import { createRoutedStream } from "./stream/routed-stream.ts";
import type { Candidate, RouterConfig } from "./types.ts";
import { type FetchImplementation, fetchCodexUsage } from "./usage/codex-usage.ts";
import { createUsageService } from "./usage/usage-service.ts";

export interface RouterController extends ProviderController {
  vault: AccountVault;
  assertReady(): Promise<void>;
  setForegroundActive(active: boolean): void;
  schedulePriming(): void;
  shutdown(): Promise<void>;
}

export interface RouterControllerOptions {
  paths: RouterPaths;
  clock?: () => number;
  oauth: CodexOAuthClient;
  fetchImpl?: FetchImplementation;
  baseStream: StreamFunction<"openai-codex-responses", SimpleStreamOptions>;
}

export async function createRouterController(
  options: RouterControllerOptions,
): Promise<RouterController> {
  const clock = options.clock ?? Date.now;
  const vaultStore = createAtomicJsonStore<AccountVaultFile>({
    path: options.paths.accounts,
    schema: AccountVaultFileSchema,
    createDefault: () => ({ version: 1, accounts: [] }),
  });
  const configStore = createAtomicJsonStore<RouterConfig>({
    path: options.paths.config,
    schema: RouterConfigSchema,
    createDefault: () => structuredClone(defaultConfig),
  });
  const stateStore = createAtomicJsonStore<RuntimeStateFile>({
    path: options.paths.state,
    schema: RuntimeStateFileSchema,
    createDefault: () => structuredClone(defaultRuntimeState),
  });
  let cachedConfig = await configStore.read();
  const vault = createAccountVault({
    store: vaultStore,
    oauth: options.oauth,
    clock,
    refreshLockDirectory: options.paths.directory,
  });
  const reservations = createReservationStore(stateStore);
  const usage = createUsageService({
    clock,
    fetchUsage: async (accountId, signal) => {
      const credential = await vault.getFreshCredential(accountId, signal);
      return fetchCodexUsage({
        accessToken: credential.accessToken,
        accountId: credential.accountId,
        managedAccountId: accountId,
        ...(signal ? { signal } : {}),
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        clock,
      });
    },
  });
  let currentAccountId: string | undefined;
  let currentModelId = Object.keys(OPENAI_CODEX_MODELS)[0] ?? "";

  const priming = createPrimingController({
    config: () => cachedConfig,
    stateStore,
    reservations,
    usage: {
      get: (accountId, getOptions) => usage.get(accountId, getOptions),
    },
    listAccountIds: async () => (await vault.list()).map((account) => account.id),
    executePrimer: async (request, signal) => {
      const model = OPENAI_CODEX_MODELS[request.modelId as keyof typeof OPENAI_CODEX_MODELS] as
        | Model<"openai-codex-responses">
        | undefined;
      if (!model) {
        throw new Error("The active Codex model is unavailable for priming");
      }
      const credential = await vault.getFreshCredential(request.accountId, signal);
      const context: Context = {
        messages: [{ role: "user", content: request.prompt, timestamp: clock() }],
        tools: [],
      };
      const stream = options.baseStream(model, context, {
        apiKey: credential.accessToken,
        reasoning: request.reasoning as ThinkingLevel,
        maxTokens: request.maxTokens,
        signal,
      });
      for await (const event of stream) {
        if (event.type === "error") {
          throw new Error(event.error.errorMessage ?? "Codex primer failed");
        }
      }
    },
    clock,
    owner: {
      processId: process.pid,
      sessionId: "pi",
      requestId: "primer-sweep",
    },
    currentModelId: () => currentModelId,
    lowestReasoning: () => "minimal",
  });

  const routedStream = createRoutedStream({
    async selectAndReserve(request) {
      currentModelId = request.model.id;
      const [summaries, config, state] = await Promise.all([
        vault.list(),
        configStore.read(),
        stateStore.read(),
      ]);
      cachedConfig = config;
      const candidates = await Promise.all(
        summaries
          .filter((account) => !request.excludedAccountIds.has(account.id))
          .map(async (account): Promise<Candidate> => {
            const snapshot = await usage
              .get(account.id, {
                ...(request.options?.signal ? { signal: request.options.signal } : {}),
              })
              .catch(() => undefined);
            const block = state.blocks.find((value) => value.accountId === account.id);
            return {
              accountId: account.id,
              label: account.label,
              needsReauth: account.needsReauth,
              ...(snapshot ? { usage: snapshot } : {}),
              ...(block ? { block } : {}),
              untouched:
                snapshot?.shortWindow.usedPercent === 0 &&
                snapshot.weeklyWindow?.usedPercent === 0 &&
                snapshot.weeklyWindow.resetsAt === undefined &&
                !state.priming.confirmedAccountIds.includes(account.id),
            };
          }),
      );
      const selected = await selectAndReserve({
        stateStore,
        request: {
          candidates,
          config,
          now: clock(),
          ...(currentAccountId ? { currentAccountId } : {}),
        },
        owner: {
          processId: process.pid,
          sessionId: request.options?.sessionId ?? "pi",
          requestId: randomUUID(),
        },
        now: clock(),
      });
      if (selected.reservation) {
        currentAccountId = selected.reservation.accountId;
        return selected.reservation;
      }
      return undefined;
    },
    getFreshCredential: (accountId, signal) => vault.getFreshCredential(accountId, signal),
    baseStream: options.baseStream,
    classifyFailure: (error) => classifyFailure(error, clock()),
    async recordFailure(accountId, failure: FailureClass) {
      if (failure.kind === "auth-invalid") {
        await vault.markNeedsReauth(accountId, "invalid_grant");
      }
      await stateStore.update((state) => ({
        ...state,
        blocks: [
          ...state.blocks.filter((block) => block.accountId !== accountId),
          blockFromFailure(accountId, failure, usage.peek(accountId), clock()),
        ],
      }));
      usage.invalidate(accountId);
    },
    release: (leaseToken) => reservations.release(leaseToken).then(() => undefined),
    waitForRecovery: (signal) =>
      waitForRecovery({
        stateStore,
        clock,
        ...(signal ? { signal } : {}),
      }),
    maxAttempts: defaultConfig.maxRotationAttempts,
  });

  return {
    bootstrapApiKey: "pending-login",
    routedStream,
    vault,
    async assertReady() {
      if ((await vault.list()).length === 0) {
        throw new Error("Run /quota-router login before using Codex");
      }
    },
    setForegroundActive(active) {
      priming.setForegroundActive(active);
    },
    schedulePriming() {
      priming.scheduleSweep("idle");
    },
    async shutdown() {
      await priming.shutdown();
    },
  };
}
