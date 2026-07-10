import { AccountNeedsReauthError } from "../accounts/account-vault.ts";
import type { UsageSnapshot } from "../types.ts";
import { raceWithSignal } from "../util/abort.ts";
import { type Clock, systemClock } from "../util/clock.ts";

const DEFAULT_FRESHNESS_MS = 300_000;
const DEFAULT_MAX_STALE_MS = 86_400_000;
const DEFAULT_MAX_CONCURRENT = 2;

export interface UsageServiceOptions {
  clock?: Clock;
  jitterMs?: (accountId: string) => number;
  fetchUsage: (accountId: string, signal?: AbortSignal) => Promise<UsageSnapshot>;
  freshnessMs?: number | (() => number);
  maxStaleMs?: number;
  maxConcurrent?: number;
}

export interface UsageGetOptions {
  force?: boolean;
  signal?: AbortSignal;
}

export interface UsageService {
  get(accountId: string, options?: UsageGetOptions): Promise<UsageSnapshot>;
  hydrate(snapshot: UsageSnapshot): void;
  peek(accountId: string): UsageSnapshot | undefined;
  invalidate(accountId: string): void;
}

interface ForcedFollowup {
  promise: Promise<UsageSnapshot>;
  started: boolean;
}

export function createUsageService(options: UsageServiceOptions): UsageService {
  const clock = options.clock ?? systemClock;
  const freshnessMs = () =>
    typeof options.freshnessMs === "function"
      ? options.freshnessMs()
      : (options.freshnessMs ?? DEFAULT_FRESHNESS_MS);
  const maxStaleMs = options.maxStaleMs ?? DEFAULT_MAX_STALE_MS;
  const jitterMs = options.jitterMs ?? (() => 0);
  const cache = new Map<string, UsageSnapshot>();
  const inflight = new Map<string, Promise<UsageSnapshot>>();
  const forcedFollowups = new Map<string, ForcedFollowup>();
  const gate = createConcurrencyGate(options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT);

  const startRequest = (accountId: string): Promise<UsageSnapshot> => {
    const request = (async () => {
      const release = await gate.acquire();
      try {
        const fresh = await options.fetchUsage(accountId);
        const normalized = fresh.stale ? { ...fresh, stale: false } : fresh;
        cache.set(accountId, normalized);
        return normalized;
      } catch (error) {
        const lastGood = cache.get(accountId);
        if (lastGood && clock() - lastGood.observedAt <= maxStaleMs) {
          return { ...lastGood, stale: true };
        }
        throw error;
      } finally {
        release();
      }
    })().finally(() => {
      if (inflight.get(accountId) === request) {
        inflight.delete(accountId);
      }
    });
    inflight.set(accountId, request);
    return request;
  };

  return {
    hydrate(snapshot) {
      const cached = cache.get(snapshot.accountId);
      if (
        !cached ||
        snapshot.observedAt > cached.observedAt ||
        (snapshot.observedAt === cached.observedAt && cached.stale && !snapshot.stale)
      ) {
        cache.set(snapshot.accountId, snapshot);
      }
    },

    async get(accountId, getOptions = {}) {
      getOptions.signal?.throwIfAborted();
      const cached = cache.get(accountId);
      const now = clock();
      if (
        !getOptions.force &&
        cached &&
        now - cached.observedAt < freshnessMs() + jitterMs(accountId) &&
        (cached.weeklyWindow?.resetsAt === undefined || cached.weeklyWindow.resetsAt > now)
      ) {
        return cached;
      }

      const queued = forcedFollowups.get(accountId);
      if (queued && !queued.started) {
        return raceWithSignal(queued.promise, getOptions.signal);
      }

      const pending = inflight.get(accountId);
      if (pending) {
        if (!getOptions.force) {
          return raceWithSignal(pending, getOptions.signal);
        }
        const predecessor = queued?.promise ?? pending;
        let followup: ForcedFollowup;
        const promise = predecessor
          .catch(() => undefined)
          .then(() => {
            followup.started = true;
            return startRequest(accountId);
          })
          .finally(() => {
            if (forcedFollowups.get(accountId) === followup) {
              forcedFollowups.delete(accountId);
            }
          });
        followup = { promise, started: false };
        forcedFollowups.set(accountId, followup);
        return raceWithSignal(followup.promise, getOptions.signal);
      }

      return raceWithSignal(startRequest(accountId), getOptions.signal);
    },

    peek(accountId) {
      return cache.get(accountId);
    },

    invalidate(accountId) {
      cache.delete(accountId);
    },
  };
}

export function createConcurrencyGate(maximum: number) {
  let active = 0;
  const waiters: Array<() => void> = [];

  return {
    async acquire(signal?: AbortSignal): Promise<() => void> {
      signal?.throwIfAborted();
      let inheritedSlot = false;
      if (active >= maximum) {
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => {
            const index = waiters.indexOf(onReady);
            if (index >= 0) {
              waiters.splice(index, 1);
            }
            reject(signal?.reason);
          };
          const onReady = () => {
            signal?.removeEventListener("abort", onAbort);
            inheritedSlot = true;
            resolve();
          };
          waiters.push(onReady);
          signal?.addEventListener("abort", onAbort, { once: true });
        });
      }
      if (!inheritedSlot) {
        signal?.throwIfAborted();
        active += 1;
      }
      let released = false;
      return () => {
        if (released) {
          return;
        }
        released = true;
        const next = waiters.shift();
        if (next) {
          next();
        } else {
          active -= 1;
        }
      };
    },
  };
}
