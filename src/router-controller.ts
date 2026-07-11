import { randomUUID } from "node:crypto";
import type {
  Context,
  SimpleStreamOptions,
  StreamFunction,
  ThinkingLevel,
} from "@earendil-works/pi-ai";
import type { AccountVault, CodexOAuthClient } from "./accounts/account-vault.ts";
import { AccountNeedsReauthError, createAccountVault } from "./accounts/account-vault.ts";
import { codexModels, codexModelsById } from "./codex-runtime.ts";
import type { QuotaRouterOperations } from "./commands/commands.ts";
import { type CodexLoginImplementation, performCodexLogin } from "./commands/login.ts";
import { defaultConfig } from "./config.ts";
import { createEventLog } from "./logging/event-log.ts";
import { createPrimingController } from "./priming/priming-controller.ts";
import type { ProviderController } from "./provider.ts";
import { classifyFailure, type FailureClass } from "./recovery/failure-classifier.ts";
import {
  blockFromFailure,
  blockFromUsage,
  reconcileUsageBlock,
} from "./recovery/recovery-state.ts";
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
import type { Candidate, RouterConfig, UsageSnapshot } from "./types.ts";
import {
  CodexUsageHttpError,
  type FetchImplementation,
  fetchCodexUsage,
} from "./usage/codex-usage.ts";
import { createUsageService } from "./usage/usage-service.ts";

export interface RouterController extends ProviderController {
  vault: AccountVault;
  operations: QuotaRouterOperations;
  assertReady(): Promise<void>;
  setForegroundActive(active: boolean): void;
  shutdown(): Promise<void>;
}

export interface RouterControllerOptions {
  paths: RouterPaths;
  clock?: () => number;
  oauth: CodexOAuthClient;
  login?: CodexLoginImplementation;
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
  const [initialConfig, initialState] = await Promise.all([configStore.read(), stateStore.read()]);
  let cachedConfig = initialConfig;
  const vault = createAccountVault({
    store: vaultStore,
    oauth: options.oauth,
    clock,
    refreshLockDirectory: options.paths.directory,
  });
  const reservations = createReservationStore(stateStore);
  const eventLog = createEventLog({ path: options.paths.log });
  const fetchUsage = async (accountId: string, signal?: AbortSignal) => {
    const request = (accessToken: string, codexAccountId: string) =>
      fetchCodexUsage({
        accessToken,
        accountId: codexAccountId,
        managedAccountId: accountId,
        ...(signal ? { signal } : {}),
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        clock,
      });
    const credential = await vault.getFreshCredential(accountId, signal);
    try {
      return await request(credential.accessToken, credential.accountId);
    } catch (error) {
      if (!(error instanceof CodexUsageHttpError) || error.status !== 401) {
        throw error;
      }
    }
    const refreshed = await vault.forceRefreshCredential(accountId, credential.accessToken, signal);
    try {
      return await request(refreshed.accessToken, refreshed.accountId);
    } catch (error) {
      if (error instanceof CodexUsageHttpError && error.status === 401) {
        await vault.markNeedsReauth(accountId, refreshed.accessToken, "revoked");
        throw new AccountNeedsReauthError();
      }
      throw error;
    }
  };
  const usage = createUsageService({
    clock,
    freshnessMs: () => cachedConfig.usageFreshnessMs,
    fetchUsage,
  });
  for (const snapshot of initialState.usageSnapshots) {
    usage.hydrate(snapshot);
  }

  const persistUsageSnapshot = async (snapshot: UsageSnapshot): Promise<void> => {
    await stateStore.update((state) => {
      const now = clock();
      const existing = state.usageSnapshots.find((value) => value.accountId === snapshot.accountId);
      const persisted =
        existing &&
        (existing.observedAt > snapshot.observedAt ||
          (existing.observedAt === snapshot.observedAt && !existing.stale && snapshot.stale))
          ? existing
          : snapshot;
      const reconciledBlocks = state.blocks.flatMap((block) => {
        if (
          block.accountId !== persisted.accountId ||
          persisted.stale ||
          persisted.observedAt <= block.blockedAt
        ) {
          return [block];
        }
        const reconciled = reconcileUsageBlock(block, persisted, now);
        return reconciled ? [reconciled] : [];
      });
      const usageBlock = persisted.stale
        ? undefined
        : blockFromUsage(persisted.accountId, persisted, now);
      const currentBlock = reconciledBlocks.find(
        (block) => block.accountId === persisted.accountId,
      );
      const blocks =
        usageBlock &&
        (!currentBlock || (currentBlock.retryAt !== undefined && currentBlock.retryAt <= now))
          ? [
              ...reconciledBlocks.filter((block) => block.accountId !== persisted.accountId),
              usageBlock,
            ]
          : reconciledBlocks;
      return {
        ...state,
        usageSnapshots: [
          ...state.usageSnapshots.filter((value) => value.accountId !== snapshot.accountId),
          persisted,
        ],
        blocks,
      };
    });
  };

  const getUsage = async (
    accountId: string,
    getOptions?: Parameters<typeof usage.get>[1],
  ): Promise<UsageSnapshot> => {
    const persisted = (await stateStore.read()).usageSnapshots.find(
      (snapshot) => snapshot.accountId === accountId,
    );
    if (persisted) {
      usage.hydrate(persisted);
    }
    const snapshot = await usage.get(accountId, getOptions);
    await persistUsageSnapshot(snapshot);
    return snapshot;
  };
  let displayAccountId: string | undefined;
  let lastSuccessfulAccountId: string | undefined;
  let currentLabel = "none";
  let currentModelId = codexModels[0]?.id ?? "";
  let loggingEnabled = true;

  const priming = createPrimingController({
    config: () => cachedConfig,
    stateStore,
    reservations,
    usage: {
      get: (accountId, getOptions) => getUsage(accountId, getOptions),
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
    onBackgroundError: (error) => {
      if (loggingEnabled) {
        void eventLog
          .append({
            type: "primer_inconclusive",
            at: clock(),
            detail: { failure: error instanceof Error ? error.name : "unknown" },
          })
          .catch(() => undefined);
      }
    },
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
        summaries.map(async (account): Promise<Candidate> => {
          const snapshot = config.manualAccountId
            ? undefined
            : await getUsage(account.id, {
                ...(request.options?.signal ? { signal: request.options.signal } : {}),
              }).catch(() => {
                request.options?.signal?.throwIfAborted();
                return undefined;
              });
          const block = state.blocks.find((value) => value.accountId === account.id);
          return {
            accountId: account.id,
            label: account.label,
            needsReauth: account.needsReauth,
            ...(snapshot ? { usage: snapshot } : {}),
            ...(block ? { block } : {}),
            untouched:
              snapshot !== undefined &&
              snapshot.shortWindow.usedPercent === 0 &&
              snapshot.weeklyWindow?.usedPercent === 0 &&
              snapshot.weeklyWindow.resetsAt === undefined &&
              !state.priming.confirmedAccountIds.includes(account.id),
          };
        }),
      );
      const selected = await selectAndReserve({
        stateStore,
        excludedAccountIds: request.excludedAccountIds,
        request: {
          candidates,
          config,
          now: clock(),
          ...(lastSuccessfulAccountId ? { currentAccountId: lastSuccessfulAccountId } : {}),
        },
        owner: {
          processId: process.pid,
          sessionId: request.options?.sessionId ?? "pi",
          requestId: randomUUID(),
        },
        now: clock(),
      });
      if (selected.reservation) {
        displayAccountId = selected.reservation.accountId;
        currentLabel =
          summaries.find((account) => account.id === displayAccountId)?.label ?? displayAccountId;
        if (loggingEnabled) {
          await eventLog.append({
            type: "account_selected",
            at: clock(),
            accountId: displayAccountId,
            detail: { reason: selected.decision.reason },
          });
        }
        return {
          kind: "selected",
          lease: {
            accountId: selected.reservation.accountId,
            leaseToken: selected.reservation.leaseToken,
            reservationTtlMs: config.reservationTtlMs,
          },
        };
      }
      return {
        kind: "unavailable",
        reason: selected.decision.reason,
        recoverableAccountIds: selected.recoverableAccountIds,
        knownAccountIds: summaries.map((account) => account.id),
      };
    },
    getFreshCredential: (accountId, signal) => vault.getFreshCredential(accountId, signal),
    forceRefreshCredential: (accountId, rejectedAccessToken, signal) =>
      vault.forceRefreshCredential(accountId, rejectedAccessToken, signal),
    baseStream: options.baseStream,
    classifyFailure: (error) => classifyFailure(error, clock()),
    async recordFailure(accountId, rejectedAccessToken, failure: FailureClass) {
      if (
        failure.kind === "auth-invalid" &&
        rejectedAccessToken &&
        !(await vault.markNeedsReauth(accountId, rejectedAccessToken, "invalid_grant"))
      ) {
        return;
      }
      const snapshot =
        failure.kind === "quota"
          ? await getUsage(accountId, { force: true }).catch(() => usage.peek(accountId))
          : usage.peek(accountId);
      await stateStore.update((state) => ({
        ...state,
        blocks: [
          ...state.blocks.filter((block) => block.accountId !== accountId),
          blockFromFailure(accountId, failure, snapshot, clock()),
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
    recordSuccess(accountId) {
      lastSuccessfulAccountId = accountId;
    },
    release: (leaseToken) => reservations.release(leaseToken).then(() => undefined),
    renew: (leaseToken, ttlMs) => reservations.renew(leaseToken, clock(), ttlMs),
    recoveryDeadline: () => clock() + cachedConfig.maxRecoveryWaitMs,
    waitForRecovery: (accountIds, knownAccountIds, deadline, signal) =>
      waitForRecovery({
        stateStore,
        clock,
        accountIds,
        knownAccountIds,
        listAccountIds: async () => (await vault.list()).map((account) => account.id),
        deadline,
        ...(signal ? { signal } : {}),
      }),
    maxAttempts: () => cachedConfig.maxRotationAttempts,
  });

  const statusText = async (): Promise<string> => {
    const [config, accounts, state] = await Promise.all([
      configStore.read(),
      vault.list(),
      stateStore.read(),
    ]);
    cachedConfig = config;
    const statusAccountId =
      config.manualAccountId ??
      displayAccountId ??
      state.lastSelection?.accountId ??
      accounts[0]?.id;
    const displayAccount = accounts.find((account) => account.id === statusAccountId);
    const snapshot = statusAccountId ? usage.peek(statusAccountId) : undefined;
    return formatCompactStatus({
      label: displayAccount?.label ?? currentLabel,
      ...(snapshot ? { snapshot } : {}),
      ...(snapshot ? { urgency: weeklyUrgency(snapshot, clock()) } : {}),
      mode: accounts.length === 0 ? "login" : config.manualAccountId ? "manual" : "auto",
      now: clock(),
    });
  };

  const resolveAccounts = async (selector: string, allowAll: boolean) => {
    const accounts = await vault.list();
    if (allowAll && selector === "all") {
      return accounts;
    }
    const exact = accounts.find((account) => account.id === selector);
    if (exact) {
      return [exact];
    }
    const matches = accounts.filter((account) => account.label === selector);
    if (matches.length > 1) {
      throw new Error(
        `Ambiguous Codex account label: ${selector}. Use a managed account id: ${matches
          .map((account) => account.id)
          .join(", ")}`,
      );
    }
    return matches;
  };

  const listAccounts = async (): Promise<string> => {
    const accounts = await vault.list();
    return accounts.length === 0
      ? "No managed Codex accounts. Run /quota-router login."
      : accounts
          .map((account) => {
            const snapshot = usage.peek(account.id);
            const quota = snapshot
              ? [
                  `5h ${remainingPercent(snapshot.shortWindow.usedPercent)}% remaining`,
                  snapshot.weeklyWindow
                    ? `7d ${remainingPercent(snapshot.weeklyWindow.usedPercent)}% remaining`
                    : "7d quota unknown",
                ].join(" · ")
              : "quota unknown";
            return `${account.id} · ${account.label} · ${
              account.needsReauth ? "reauth required" : "ready"
            } · ${quota}`;
          })
          .join("\n");
  };

  const operations: QuotaRouterOperations = {
    dashboard: statusText,
    status: statusText,
    accounts: listAccounts,
    list: listAccounts,
    async login(label, ctx) {
      const result = await performCodexLogin({
        ctx,
        ...(label ? { label } : {}),
        vault,
        ...(options.login ? { login: options.login } : {}),
        onAccountAdded: async ({ id, label: addedLabel }) => {
          await stateStore.update((state) => ({
            ...state,
            blocks: state.blocks.filter((block) => block.accountId !== id || block.kind !== "auth"),
          }));
          usage.invalidate(id);
          displayAccountId = id;
          currentLabel = addedLabel;
        },
      });
      displayAccountId = result.id;
      currentLabel = result.label;
      return result.message;
    },
    async use(selector) {
      if (selector === "auto") {
        cachedConfig = await configStore.update((config) => {
          const { manualAccountId: _manual, ...automatic } = config;
          return automatic;
        });
        return "Routing returned to automatic quota-aware selection.";
      }
      const account = (await resolveAccounts(selector, false))[0];
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
      const selected = await resolveAccounts(selector, true);
      if (selected.length === 0) {
        throw new Error(`No Codex account matches ${selector}`);
      }
      for (const account of selected) {
        await vault.getFreshCredential(account.id);
        await getUsage(account.id, { force: true });
      }
      return `Refreshed ${selected.length} Codex account${selected.length === 1 ? "" : "s"}.`;
    },
    async prime(selector = "all", modelId) {
      const selected = await resolveAccounts(selector, true);
      if (selected.length === 0) {
        throw new Error(`No Codex account matches ${selector}`);
      }
      const primerModelId = modelId ?? currentModelId;
      if (!codexModelsById.has(primerModelId)) {
        throw new Error(`Codex model ${primerModelId} is unavailable for priming`);
      }
      const results = [];
      for (const account of selected) {
        const result = await priming.primeAccount(account.id, {
          authorization: "one-shot",
          modelId: primerModelId,
        });
        results.push(`${account.label}: ${result.status}`);
        if (
          result.status === "confirmed" ||
          result.status === "inconclusive" ||
          result.status === "failed"
        ) {
          break;
        }
      }
      return results.join("\n");
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
        vaultStatus.valid &&
        configStatus.valid &&
        stateStatus.valid &&
        vaultStatus.mode === 0o600 &&
        configStatus.mode === 0o600 &&
        stateStatus.mode === 0o600
          ? "healthy"
          : "invalid";
      const modes = [
        `accounts.json=${formatMode(vaultStatus.mode)}`,
        `config.json=${formatMode(configStatus.mode)}`,
        `state.json=${formatMode(stateStatus.mode)}`,
      ].join(", ");
      return `Quota router is ${healthy}; ${accounts.length} account(s); files mode ${modes}.`;
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
    async shutdown() {
      await priming.shutdown();
    },
  };
}

function formatMode(mode: number | undefined): string {
  return mode === undefined ? "missing" : mode.toString(8).padStart(4, "0");
}

function remainingPercent(usedPercent: number): number {
  return Math.max(0, Math.round(100 - usedPercent));
}
