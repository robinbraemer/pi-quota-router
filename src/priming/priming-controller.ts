import { randomUUID } from "node:crypto";
import { isPrimingAuthorized } from "../config.ts";
import { startReservationHeartbeat } from "../routing/reservation-heartbeat.ts";
import type { ReservationStore } from "../routing/reservation-store.ts";
import type { AtomicJsonStore } from "../storage/atomic-json-store.ts";
import type { RuntimeStateFile } from "../storage/schemas.ts";
import type { Reservation, ReservationOwner, RouterConfig, UsageSnapshot } from "../types.ts";

export interface PrimerRequest {
  accountId: string;
  modelId: string;
  prompt: ".";
  messages: [];
  tools: [];
  reasoning: string;
  maxTokens: 1;
}

export type PrimerResult =
  | { status: "not_authorized" }
  | { status: "busy" }
  | { status: "not_candidate" }
  | { status: "reserved" }
  | { status: "inconclusive" }
  | { status: "failed" }
  | { status: "confirmed"; resetAt: number };

export interface PrimingControllerOptions {
  config: () => RouterConfig;
  stateStore: AtomicJsonStore<RuntimeStateFile>;
  reservations: ReservationStore;
  usage: {
    get(accountId: string, options: { force: true; signal?: AbortSignal }): Promise<UsageSnapshot>;
  };
  listAccountIds: () => Promise<string[]>;
  executePrimer: (request: PrimerRequest, signal: AbortSignal) => Promise<void>;
  clock: () => number;
  owner: ReservationOwner;
  currentModelId: () => string;
  lowestReasoning: () => string;
  onBackgroundError?: (error: unknown) => void;
}

export interface PrimingController {
  primeAccount(
    accountId: string,
    options?: { authorization: "one-shot"; modelId?: string },
  ): Promise<PrimerResult>;
  setForegroundActive(active: boolean): void;
  scheduleSweep(reason: "startup" | "manual" | "idle"): void;
  shutdown(): Promise<void>;
}

class PrimingInterruptedError extends Error {
  override readonly name = "PrimingInterruptedError";
}

export function createPrimingController(options: PrimingControllerOptions): PrimingController {
  let foregroundActive = false;
  let activeAbort: AbortController | undefined;
  let background: Promise<void> | undefined;

  const primeAccount = async (
    accountId: string,
    invocation?: { authorization: "one-shot"; modelId?: string },
  ): Promise<PrimerResult> => {
    const config = options.config();
    if (!isPrimingAuthorized(config) && invocation?.authorization !== "one-shot") {
      return { status: "not_authorized" };
    }
    if (foregroundActive) {
      return { status: "busy" };
    }

    const now = options.clock();
    const state = await options.stateStore.read();
    if (
      state.priming.confirmedAccountIds.includes(accountId) ||
      (state.priming.retryAfter[accountId] ?? 0) > now
    ) {
      return { status: "not_candidate" };
    }

    const sweep = await options.reservations.acquirePrimerSweep(
      options.owner,
      now,
      config.reservationTtlMs,
    );
    if (!sweep) {
      return { status: "reserved" };
    }
    if (foregroundActive) {
      await options.reservations.release(sweep.leaseToken);
      return { status: "busy" };
    }

    let accountLease: Reservation | undefined;
    let accountHeartbeat: ReturnType<typeof startReservationHeartbeat> | undefined;
    const controller = new AbortController();
    activeAbort = controller;
    const sweepHeartbeat = startReservationHeartbeat({
      leaseToken: sweep.leaseToken,
      ttlMs: config.reservationTtlMs,
      renew: (leaseToken, ttlMs) => options.reservations.renew(leaseToken, options.clock(), ttlMs),
      signal: controller.signal,
    });
    try {
      accountLease = await reservePrimerAccount(options, accountId, now, config.reservationTtlMs);
      if (!accountLease) {
        return { status: "reserved" };
      }
      accountHeartbeat = startReservationHeartbeat({
        leaseToken: accountLease.leaseToken,
        ttlMs: config.reservationTtlMs,
        renew: (leaseToken, ttlMs) =>
          options.reservations.renew(leaseToken, options.clock(), ttlMs),
        signal: sweepHeartbeat.signal,
      });
      const signal = accountHeartbeat.signal;
      const before = await options.usage.get(accountId, {
        force: true,
        signal,
      });
      if (!isUntouchedCandidate(before)) {
        return { status: "not_candidate" };
      }

      let providerFailed = false;
      try {
        await options.executePrimer(
          {
            accountId,
            modelId: invocation?.modelId ?? options.currentModelId(),
            prompt: ".",
            messages: [],
            tools: [],
            reasoning: options.lowestReasoning(),
            maxTokens: 1,
          },
          signal,
        );
      } catch {
        signal.throwIfAborted();
        providerFailed = true;
      }
      const after = await options.usage.get(accountId, {
        force: true,
        signal,
      });
      const resetAt = after.weeklyWindow?.resetsAt;
      if (resetAt !== undefined) {
        await options.stateStore.update((current) => {
          const retryAfter = { ...current.priming.retryAfter };
          delete retryAfter[accountId];
          return {
            ...current,
            priming: {
              confirmedAccountIds: Array.from(
                new Set([...current.priming.confirmedAccountIds, accountId]),
              ),
              retryAfter,
            },
          };
        });
        return providerFailed ? { status: "failed" } : { status: "confirmed", resetAt };
      }

      await applyRetryCooldown(options, accountId, now, config.priming.retryCooldownMs);
      return providerFailed ? { status: "failed" } : { status: "inconclusive" };
    } catch (_error) {
      if (controller.signal.aborted) {
        throw controller.signal.reason;
      }
      await applyRetryCooldown(options, accountId, now, config.priming.retryCooldownMs);
      return { status: "failed" };
    } finally {
      activeAbort = undefined;
      await accountHeartbeat?.stop();
      await sweepHeartbeat.stop();
      if (accountLease) {
        await options.reservations.release(accountLease.leaseToken);
      }
      await options.reservations.release(sweep.leaseToken);
    }
  };

  return {
    primeAccount,

    setForegroundActive(active) {
      foregroundActive = active;
      if (active) {
        activeAbort?.abort(new PrimingInterruptedError("Foreground request started"));
      }
    },

    scheduleSweep(_reason) {
      if (foregroundActive || background || !isPrimingAuthorized(options.config())) {
        return;
      }
      background = (async () => {
        const ids = await options.listAccountIds();
        let attempts = 0;
        for (const accountId of ids) {
          if (foregroundActive) {
            break;
          }
          const result = await primeAccount(accountId);
          if (
            result.status === "confirmed" ||
            result.status === "inconclusive" ||
            result.status === "failed"
          ) {
            attempts += 1;
          }
          if (attempts >= options.config().priming.maximumPerSweep) {
            break;
          }
        }
      })()
        .catch((error) => {
          if (error instanceof PrimingInterruptedError) {
            return;
          }
          try {
            options.onBackgroundError?.(error);
          } catch {}
        })
        .finally(() => {
          background = undefined;
        });
    },

    async shutdown() {
      activeAbort?.abort(new PrimingInterruptedError("Pi session is shutting down"));
      await background?.catch(() => undefined);
    },
  };
}

function isUntouchedCandidate(snapshot: UsageSnapshot): boolean {
  return (
    !snapshot.stale &&
    snapshot.shortWindow !== undefined &&
    snapshot.shortWindow.usedPercent === 0 &&
    snapshot.weeklyWindow?.usedPercent === 0 &&
    snapshot.weeklyWindow.resetsAt === undefined
  );
}

async function reservePrimerAccount(
  options: PrimingControllerOptions,
  accountId: string,
  now: number,
  ttlMs: number,
): Promise<Reservation | undefined> {
  let acquired: Reservation | undefined;
  await options.stateStore.update((state) => {
    const reservations = state.reservations.filter((value) => value.expiresAt > now);
    const blocked = state.blocks.some(
      (value) =>
        value.accountId === accountId && (value.retryAt === undefined || value.retryAt > now),
    );
    if (blocked || reservations.some((value) => value.accountId === accountId)) {
      return { ...state, reservations };
    }
    acquired = {
      accountId,
      leaseToken: randomUUID(),
      owner: options.owner,
      createdAt: now,
      expiresAt: now + ttlMs,
      kind: "primer",
    };
    return { ...state, reservations: [...reservations, acquired] };
  });
  return acquired;
}

async function applyRetryCooldown(
  options: PrimingControllerOptions,
  accountId: string,
  now: number,
  cooldownMs: number,
): Promise<void> {
  await options.stateStore.update((state) => ({
    ...state,
    priming: {
      ...state.priming,
      retryAfter: { ...state.priming.retryAfter, [accountId]: now + cooldownMs },
    },
  }));
}
