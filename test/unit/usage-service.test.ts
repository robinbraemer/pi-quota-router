import { describe, expect, test } from "bun:test";
import { AccountNeedsReauthError } from "../../src/accounts/account-vault.ts";
import type { UsageSnapshot } from "../../src/types.ts";
import { createUsageService } from "../../src/usage/usage-service.ts";

function snapshot(accountId: string, observedAt: number): UsageSnapshot {
  return {
    accountId,
    observedAt,
    shortWindow: { usedPercent: 10, resetsAt: observedAt + 3_600_000 },
    weeklyWindow: { usedPercent: 20, resetsAt: observedAt + 604_800_000 },
    stale: false,
  };
}

describe("UsageService", () => {
  test("keeps a shared refresh alive when its first caller aborts", async () => {
    const firstCaller = new AbortController();
    let resolveFetch: ((value: UsageSnapshot) => void) | undefined;
    let receivedSignal: AbortSignal | undefined;
    let markFetchStarted: (() => void) | undefined;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    const service = createUsageService({
      clock: () => 1,
      jitterMs: () => 0,
      fetchUsage: (_accountId, signal) => {
        receivedSignal = signal;
        markFetchStarted?.();
        return new Promise<UsageSnapshot>((resolve, reject) => {
          resolveFetch = resolve;
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    });

    const first = service.get("a", { signal: firstCaller.signal });
    const second = service.get("a");
    const firstOutcome = first.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    const secondOutcome = second.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await fetchStarted;
    firstCaller.abort(new Error("first caller cancelled"));

    const cancelled = await firstOutcome;
    expect("error" in cancelled ? cancelled.error : undefined).toEqual(
      new Error("first caller cancelled"),
    );
    resolveFetch?.(snapshot("a", 1));
    expect(await secondOutcome).toEqual({ value: snapshot("a", 1) });
    expect(receivedSignal).toBeUndefined();
  });

  test("coalesces refreshes and serves a five-minute fresh value", async () => {
    let now = 1_000_000;
    let calls = 0;
    const service = createUsageService({
      clock: () => now,
      jitterMs: () => 0,
      fetchUsage: async (accountId) => {
        calls += 1;
        await Bun.sleep(10);
        return snapshot(accountId, now);
      },
    });

    const [first, second] = await Promise.all([service.get("a"), service.get("a")]);
    expect(first).toEqual(second);
    expect(calls).toBe(1);
    now += 299_999;
    expect(await service.get("a")).toEqual(first);
    expect(calls).toBe(1);
    expect(await service.get("a", { force: true })).not.toBe(first);
    expect(calls).toBe(2);
  });

  test("allows at most two upstream usage requests concurrently", async () => {
    let active = 0;
    let maximum = 0;
    const service = createUsageService({
      clock: () => 1,
      jitterMs: () => 0,
      fetchUsage: async (accountId) => {
        active += 1;
        maximum = Math.max(maximum, active);
        await Bun.sleep(15);
        active -= 1;
        return snapshot(accountId, 1);
      },
    });

    await Promise.all(["a", "b", "c", "d"].map((accountId) => service.get(accountId)));
    expect(maximum).toBe(2);
  });

  test("uses the current configured freshness threshold", async () => {
    let now = 1_000_000;
    let freshnessMs = 300_000;
    let calls = 0;
    const service = createUsageService({
      clock: () => now,
      freshnessMs: () => freshnessMs,
      jitterMs: () => 0,
      fetchUsage: async (accountId) => {
        calls += 1;
        return snapshot(accountId, now);
      },
    });

    await service.get("a");
    freshnessMs = 1;
    now += 2;
    await service.get("a");

    expect(calls).toBe(2);
  });

  test("returns a marked last-good value for up to 24 hours", async () => {
    let now = 1_000_000;
    let fail = false;
    const service = createUsageService({
      clock: () => now,
      jitterMs: () => 0,
      fetchUsage: async (accountId) => {
        if (fail) {
          throw new Error("offline");
        }
        return snapshot(accountId, now);
      },
    });

    await service.get("a");
    fail = true;
    now += 300_001;
    expect(await service.get("a")).toEqual(expect.objectContaining({ stale: true }));
    now += 86_400_001;
    await expect(service.get("a", { force: true })).rejects.toThrow("offline");
  });

  test("never masks a definitive authentication failure with stale usage", async () => {
    let failAuth = false;
    const service = createUsageService({
      clock: () => 1_000_000,
      jitterMs: () => 0,
      fetchUsage: async (accountId) => {
        if (failAuth) {
          throw new AccountNeedsReauthError();
        }
        return snapshot(accountId, 1_000_000);
      },
    });

    await service.get("a");
    failAuth = true;

    await expect(service.get("a", { force: true })).rejects.toBeInstanceOf(AccountNeedsReauthError);
  });
});
