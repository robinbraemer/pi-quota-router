import { setTimeout as delay } from "node:timers/promises";
import type { AtomicJsonStore } from "../storage/atomic-json-store.ts";
import type { RuntimeStateFile } from "../storage/schemas.ts";

const DEFAULT_RECHECK_MS = 60_000;
const DEFAULT_MAX_WAIT_MS = 21_600_000;

export class RecoveryWaitTimeoutError extends Error {
  override readonly name = "RecoveryWaitTimeoutError";

  constructor() {
    super("No Codex account recovered within the configured wait limit");
  }
}

export class NoRecoverableAccountError extends Error {
  override readonly name = "NoRecoverableAccountError";

  constructor() {
    super("No temporarily blocked Codex account can recover automatically");
  }
}

export interface WaitForRecoveryOptions {
  stateStore: AtomicJsonStore<RuntimeStateFile>;
  accountIds?: readonly string[];
  knownAccountIds?: readonly string[];
  listAccountIds?: () => Promise<readonly string[]>;
  clock: () => number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  recheckMs?: number;
  maxWaitMs?: number;
  deadline?: number;
}

export async function waitForRecovery(options: WaitForRecoveryOptions): Promise<void> {
  const startedAt = options.clock();
  const deadline = options.deadline ?? startedAt + (options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS);
  const recheckMs = options.recheckMs ?? DEFAULT_RECHECK_MS;
  const sleep =
    options.sleep ??
    ((milliseconds: number, signal?: AbortSignal) =>
      delay(milliseconds, undefined, signal ? { signal } : undefined));

  while (true) {
    options.signal?.throwIfAborted();
    const now = options.clock();
    if (now >= deadline) {
      throw new RecoveryWaitTimeoutError();
    }
    if (options.knownAccountIds && options.listAccountIds) {
      const knownAccountIds = new Set(options.knownAccountIds);
      if ((await options.listAccountIds()).some((accountId) => !knownAccountIds.has(accountId))) {
        return;
      }
    }
    const state = await options.stateStore.read();
    const accountIds = options.accountIds ? new Set(options.accountIds) : undefined;
    const blocks = (
      accountIds ? state.blocks.filter((block) => accountIds.has(block.accountId)) : state.blocks
    ).filter((block) => block.retryAt === undefined || block.retryAt > now);
    const reservations = accountIds
      ? state.reservations.filter(
          (reservation) => accountIds.has(reservation.accountId) && reservation.expiresAt > now,
        )
      : [];
    const unavailableAccountIds = new Set([
      ...blocks.map((block) => block.accountId),
      ...reservations.map((reservation) => reservation.accountId),
    ]);
    if (
      accountIds
        ? accountIds.size === 0 ||
          [...accountIds].some((accountId) => !unavailableAccountIds.has(accountId))
        : blocks.length === 0
    ) {
      return;
    }
    const retryTimes = [
      ...blocks.map((block) => block.retryAt),
      ...reservations.map((reservation) => reservation.expiresAt),
    ].filter((retryAt): retryAt is number => retryAt !== undefined);
    if (retryTimes.length === 0) {
      throw new NoRecoverableAccountError();
    }
    const earliest = Math.min(...retryTimes);
    if (earliest <= now) {
      return;
    }
    const duration = Math.min(recheckMs, earliest - now, deadline - now);
    await sleep(duration, options.signal);
  }
}
