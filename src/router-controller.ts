import { randomUUID } from "node:crypto";
import type {
  Context,
  SimpleStreamOptions,
  StreamFunction,
  ThinkingLevel,
} from "@earendil-works/pi-ai";
import type { AccountVault, CodexOAuthClient } from "./accounts/account-vault.ts";
import { createAccountVault } from "./accounts/account-vault.ts";
import { codexModels, codexModelsById } from "./codex-runtime.ts";
import type { QuotaRouterOperations } from "./commands/commands.ts";
import { performCodexLogin } from "./commands/login.ts";
import { defaultConfig } from "./config.ts";
import { createEventLog } from "./logging/event-log.ts";
import { createPrimingController } from "./priming/priming-controller.ts";
import type { ProviderController } from "./provider.ts";
import { classifyFailure, type FailureClass } from "./recovery/failure-classifier.ts";
import { blockFromFailure } from "./recovery/recovery-state.ts";
import { waitForRecovery } from "./recovery/wait-for-recovery.ts";
import { createReservationStore } from "./routing/reservation-store.ts";
import { selectAndReserve } from "./routing/select-and-reserve.ts";
import { weeklyUrgency } from "./routing/selection-policy.ts";
import { formatCompactStatus } from "./status/status-controller.ts";
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
  operations: QuotaRouterOperations;
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
  const eventLog = createEventLog({ path: options.paths.log });
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
  let currentLabel = "none";
  let currentModelId = codexModels[0]?.id ?? "";
  let loggingEnabled = true;

  const priming = createPrimingController({
    config: () => cachedConfig,
    stateStore,
    reservations,
    usage: {
      get: (accountId, getOptions) => usage.get(accountId, getOptions),
    },
    listAccountIds: async () => (await vault.list()).map((account) => account.id),
    executePrimer: async (request, signal) => {
      const model = codexModelsById.get(request.modelId);
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
        currentLabel =
          summaries.find((account) => account.id === currentAccountId)?.label ?? currentAccountId;
        if (loggingEnabled) {
          await eventLog.append({
            type: "account_selected",
            at: clock(),
            accountId: currentAccountId,
            detail: { reason: selected.decision.reason },
          });
        }
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
      if (loggingEnabled) {
        await eventLog.append({
          type: failure.kind === "auth-invalid" ? "auth_invalidated" : "quota_blocked",
          at: clock(),
          accountId,
          detail: { failure: failure.kind },
        });
      }
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

  const statusText = async (): Promise<string> => {
    const config = await configStore.read();
    cachedConfig = config;
    const snapshot = currentAccountId ? usage.peek(currentAccountId) : undefined;
    return formatCompactStatus({
      label: currentLabel,
      ...(snapshot ? { snapshot } : {}),
      ...(snapshot ? { urgency: weeklyUrgency(snapshot, clock()) } : {}),
      mode: config.manualAccountId ? "manual" : currentAccountId ? "auto" : "login",
      now: clock(),
    });
  };

  const resolveAccount = async (selector: string) => {
    const accounts = await vault.list();
    return accounts.find((account) => account.id === selector || account.label === selector);
  };

  const operations: QuotaRouterOperations = {
    dashboard: statusText,
    status: statusText,
    async accounts() {
      const accounts = await vault.list();
      return accounts.length === 0
        ? "No managed Codex accounts. Run /quota-router login."
        : accounts
            .map(
              (account) =>
                `${account.id} · ${account.label} · ${account.needsReauth ? "reauth required" : "ready"}`,
            )
            .join("\n");
    },
    login: (label, ctx) => performCodexLogin({ ctx, ...(label ? { label } : {}), vault }),
    async use(selector) {
      if (selector === "auto") {
        cachedConfig = await configStore.update((config) => {
          const { manualAccountId: _manual, ...automatic } = config;
          return automatic;
        });
        return "Routing returned to automatic quota-aware selection.";
      }
      const account = await resolveAccount(selector);
      if (!account) {
        throw new Error(`Unknown Codex account: ${selector}`);
      }
      cachedConfig = await configStore.update((config) => ({
        ...config,
        manualAccountId: account.id,
      }));
      return `Manual routing set to ${account.label} (${account.id}).`;
    },
    async refresh(selector = "all") {
      const accounts = await vault.list();
      const selected =
        selector === "all"
          ? accounts
          : accounts.filter((account) => account.id === selector || account.label === selector);
      if (selected.length === 0) {
        throw new Error(`No Codex account matches ${selector}`);
      }
      for (const account of selected) {
        await vault.getFreshCredential(account.id);
        await usage.get(account.id, { force: true });
      }
      return `Refreshed ${selected.length} Codex account${selected.length === 1 ? "" : "s"}.`;
    },
    async prime(selector = "all") {
      const accounts = await vault.list();
      const selected =
        selector === "all"
          ? accounts
          : accounts.filter((account) => account.id === selector || account.label === selector);
      if (selected.length === 0) {
        throw new Error(`No Codex account matches ${selector}`);
      }
      const results = [];
      for (const account of selected) {
        results.push(`${account.label}: ${(await priming.primeAccount(account.id)).status}`);
      }
      return results.join("\n");
    },
    async confirmPriming() {
      cachedConfig = await configStore.update((config) => ({
        ...config,
        priming: {
          ...config.priming,
          enabled: true,
          confirmedFirstUseRollingWindow: true,
        },
      }));
      return "Synthetic priming is explicitly enabled for confirmed rolling windows.";
    },
    async policy() {
      cachedConfig = await configStore.read();
      return JSON.stringify(cachedConfig, null, 2);
    },
    async reset(scope) {
      await stateStore.update((state) => ({
        ...state,
        blocks: scope === "cooldowns" || scope === "all" ? [] : state.blocks,
        reservations: scope === "reservations" || scope === "all" ? [] : state.reservations,
        priming:
          scope === "priming" || scope === "all"
            ? structuredClone(defaultRuntimeState.priming)
            : state.priming,
      }));
      return `Reset quota-router ${scope} state.`;
    },
    async verify() {
      const [vaultStatus, configStatus, stateStatus, accounts] = await Promise.all([
        vaultStore.inspect(),
        configStore.inspect(),
        stateStore.inspect(),
        vault.list(),
      ]);
      const healthy =
        vaultStatus.valid && configStatus.valid && stateStatus.valid ? "healthy" : "invalid";
      return `Quota router is ${healthy}; ${accounts.length} account(s); files mode 0600.`;
    },
    async paths() {
      return [
        `accounts: ${options.paths.accounts}`,
        `config: ${options.paths.config}`,
        `state: ${options.paths.state}`,
        `log: ${options.paths.log}`,
      ].join("\n");
    },
    async log(mode) {
      if (mode === "on") loggingEnabled = true;
      if (mode === "off") loggingEnabled = false;
      return `Diagnostic logging is ${loggingEnabled ? "on" : "off"}; ${options.paths.log}`;
    },
  };

  return {
    bootstrapApiKey: "pending-login",
    routedStream,
    vault,
    operations,
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
