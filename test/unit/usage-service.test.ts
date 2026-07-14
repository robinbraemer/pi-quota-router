import { describe, expect, test } from "bun:test";
import { AccountNeedsReauthError } from "../../src/accounts/account-vault.ts";
import type { UsageSnapshot } from "../../src/types.ts";
import { createConcurrencyGate, createUsageService } from "../../src/usage/usage-service.ts";

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

  test("hydrates a persisted snapshot before fetching", async () => {
    let calls = 0;
    const service = createUsageService({
      clock: () => 1_100_000,
      jitterMs: () => 0,
      fetchUsage: async (accountId) => {
        calls += 1;
        return snapshot(accountId, 1_100_000);
      },
    });

    service.hydrate(snapshot("a", 1_000_000));

    expect(await service.get("a")).toEqual(snapshot("a", 1_000_000));
    expect(calls).toBe(0);
  });

  test("serves a fresh weekly-only snapshot without fetching", async () => {
    let calls = 0;
    const weeklyOnly: UsageSnapshot = {
      accountId: "a",
      observedAt: 1_000_000,
      weeklyWindow: { usedPercent: 3, resetsAt: 605_800_000 },
      stale: false,
    };
    const service = createUsageService({
      clock: () => 1_100_000,
      jitterMs: () => 0,
      fetchUsage: async (accountId) => {
        calls += 1;
        return snapshot(accountId, 1_100_000);
      },
    });

    service.hydrate(weeklyOnly);

    expect(await service.get("a")).toEqual(weeklyOnly);
    expect(calls).toBe(0);
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

  test("refreshes a cached snapshot after its weekly reset elapses", async () => {
    let now = 1_000_000;
    let calls = 0;
    const service = createUsageService({
      clock: () => now,
      jitterMs: () => 0,
      fetchUsage: async (accountId) => {
        calls += 1;
        return {
          ...snapshot(accountId, now),
          weeklyWindow: { usedPercent: 20, resetsAt: now + 1_000 },
        };
      },
    });

    await service.get("a");
    now += 1_001;
    await service.get("a");

    expect(calls).toBe(2);
  });

  test("refreshes a cached snapshot after its short reset elapses", async () => {
    let now = 1_000_000;
    let calls = 0;
    const service = createUsageService({
      clock: () => now,
      jitterMs: () => 0,
      fetchUsage: async (accountId) => {
        calls += 1;
        return {
          ...snapshot(accountId, now),
          shortWindow: { usedPercent: 100, resetsAt: now + 1_000 },
        };
      },
    });

    await service.get("a");
    now += 1_001;
    await service.get("a");

    expect(calls).toBe(2);
  });

  test("runs a forced fetch after a request that was already in flight", async () => {
    let releaseFirst: (() => void) | undefined;
    let calls = 0;
    const service = createUsageService({
      clock: () => 1_000_000,
      jitterMs: () => 0,
      fetchUsage: async (accountId) => {
        calls += 1;
        if (calls === 1) {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
        return snapshot(accountId, 1_000_000 + calls);
      },
    });

    const first = service.get("a");
    await Bun.sleep(0);
    const forced = service.get("a", { force: true });
    releaseFirst?.();

    expect((await first).observedAt).toBe(1_000_001);
    expect((await forced).observedAt).toBe(1_000_002);
    expect(calls).toBe(2);
  });

  test("coalesces forced fetches queued behind the same in-flight request", async () => {
    let releaseFirst: (() => void) | undefined;
    let calls = 0;
    const service = createUsageService({
      clock: () => 1_000_000,
      jitterMs: () => 0,
      fetchUsage: async (accountId) => {
        calls += 1;
        if (calls === 1) {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
        return snapshot(accountId, 1_000_000 + calls);
      },
    });

    const first = service.get("a");
    await Bun.sleep(0);
    const forced = [service.get("a", { force: true }), service.get("a", { force: true })];
    releaseFirst?.();

    expect((await first).observedAt).toBe(1_000_001);
    expect((await Promise.all(forced)).map((value) => value.observedAt)).toEqual([
      1_000_002, 1_000_002,
    ]);
    expect(calls).toBe(2);
  });

  test("does not start a duplicate forced fetch during follow-up handoff", async () => {
    let releaseFirst: (() => void) | undefined;
    let calls = 0;
    let requestDuringHandoff: Promise<UsageSnapshot> | undefined;
    const service = createUsageService({
      clock: () => 1_000_000,
      jitterMs: () => 0,
      fetchUsage: async (accountId) => {
        calls += 1;
        if (calls === 1) {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
        return snapshot(accountId, 1_000_000 + calls);
      },
    });

    const first = service.get("a");
    await Bun.sleep(0);
    const forced = service.get("a", { force: true });
    first.finally(() => {
      requestDuringHandoff = service.get("a", { force: true });
    });
    releaseFirst?.();

    expect((await forced).observedAt).toBe(1_000_002);
    expect((await requestDuringHandoff)?.observedAt).toBe(1_000_002);
    expect(calls).toBe(2);
  });

  test("lets each caller abort independently while a shared fetch continues", async () => {
    let releaseFetch: (() => void) | undefined;
    let upstreamSignal: AbortSignal | undefined;
    let calls = 0;
    const service = createUsageService({
      clock: () => 1_000_000,
      jitterMs: () => 0,
      fetchUsage: async (accountId, signal) => {
        calls += 1;
        upstreamSignal = signal;
        await new Promise<void>((resolve, reject) => {
          releaseFetch = resolve;
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        return snapshot(accountId, 1_000_000);
      },
    });
    const cancellation = new AbortController();
    const reason = new Error("cancelled caller");

    const cancelled = service.get("a", { signal: cancellation.signal });
    await Bun.sleep(0);
    const active = service.get("a");
    const activeResult = active.then(
      (value) => value,
      (error) => error,
    );
    cancellation.abort(reason);

    await expect(cancelled).rejects.toBe(reason);
    expect(upstreamSignal).toBeUndefined();
    releaseFetch?.();
    expect(await activeResult).toEqual(snapshot("a", 1_000_000));
    expect(calls).toBe(1);
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

  test("hands a released concurrency slot to the oldest waiter", async () => {
    const gate = createConcurrencyGate(1);
    const releaseFirst = await gate.acquire();
    let waitingAcquired = false;
    let newcomerAcquired = false;
    const waiting = gate.acquire().then((release) => {
      waitingAcquired = true;
      return release;
    });

    releaseFirst();
    const newcomer = gate.acquire().then((release) => {
      newcomerAcquired = true;
      return release;
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(waitingAcquired).toBe(true);
    expect(newcomerAcquired).toBe(false);
    (await waiting)();
    (await newcomer)();
  });

  test("rejects an already-aborted waiter before queueing it", async () => {
    const gate = createConcurrencyGate(1);
    const release = await gate.acquire();
    const cancellation = new AbortController();
    const reason = new Error("already cancelled");
    cancellation.abort(reason);

    const outcome = await Promise.race([
      gate.acquire(cancellation.signal).then(
        () => "acquired",
        (error) => error,
      ),
      Bun.sleep(10).then(() => "still waiting"),
    ]);

    expect(outcome).toBe(reason);
    release();
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
