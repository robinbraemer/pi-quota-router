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
  clock: () => number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  recheckMs?: number;
  maxWaitMs?: number;
}

export async function waitForRecovery(options: WaitForRecoveryOptions): Promise<void> {
  const startedAt = options.clock();
  const deadline = startedAt + (options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS);
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
    const state = await options.stateStore.read();
    if (state.blocks.length === 0) {
      return;
    }
    const retryTimes = state.blocks
      .map((block) => block.retryAt)
      .filter((retryAt): retryAt is number => retryAt !== undefined);
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
