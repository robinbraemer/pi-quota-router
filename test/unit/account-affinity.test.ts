import { describe, expect, test } from "bun:test";
import { createAccountAffinityCoordinator } from "../../src/stream/account-affinity.ts";

describe("AccountAffinityCoordinator", () => {
  test("closes the exact original session only before a different-account attempt", async () => {
    const closed: Array<string | undefined> = [];
    const coordinator = createAccountAffinityCoordinator((sessionId) => closed.push(sessionId));
    const lease = await coordinator.acquire("  original/session  ");

    lease.beforeAttempt("codex-account-a");
    lease.beforeAttempt("codex-account-a");
    expect(closed).toEqual([]);

    lease.beforeAttempt("codex-account-b");
    expect(closed).toEqual(["  original/session  "]);
    lease.beforeAttempt("codex-account-b");
    expect(closed).toEqual(["  original/session  "]);
    lease.release();
  });

  test("does not track or close when Pi supplied no cacheable session id", async () => {
    const closed: Array<string | undefined> = [];
    const coordinator = createAccountAffinityCoordinator((sessionId) => closed.push(sessionId));
    const lease = await coordinator.acquire(undefined);
    lease.beforeAttempt("codex-account-a");
    lease.beforeAttempt("codex-account-b");
    lease.release();
    coordinator.shutdown();
    expect(closed).toEqual([]);
  });

  test("queues overlapping work for one session but not another session", async () => {
    const coordinator = createAccountAffinityCoordinator(() => undefined);
    const first = await coordinator.acquire("one");
    let secondAcquired = false;
    const secondPromise = coordinator.acquire("one").then((lease) => {
      secondAcquired = true;
      return lease;
    });
    const other = await coordinator.acquire("two");

    await Promise.resolve();
    expect(secondAcquired).toBeFalse();
    other.release();
    first.release();
    const second = await secondPromise;
    expect(secondAcquired).toBeTrue();
    second.release();
  });

  test("aborts a queued waiter without blocking the next waiter", async () => {
    const coordinator = createAccountAffinityCoordinator(() => undefined);
    const owner = await coordinator.acquire("session");
    const abort = new AbortController();
    const cancelled = coordinator.acquire("session", abort.signal);
    abort.abort(new Error("synthetic cancellation"));
    await expect(cancelled).rejects.toThrow("synthetic cancellation");
    owner.release();
    const next = await coordinator.acquire("session");
    next.release();
  });

  test("does not advance account identity when close fails", async () => {
    let fail = true;
    const coordinator = createAccountAffinityCoordinator(() => {
      if (fail) throw new Error("synthetic close failure");
    });
    const lease = await coordinator.acquire("session");
    lease.beforeAttempt("a");
    expect(() => lease.beforeAttempt("b")).toThrow("synthetic close failure");
    fail = false;
    lease.beforeAttempt("b");
    lease.release();
  });

  test("shutdown closes every tracked original session once and rejects waiters", async () => {
    const closed: Array<string | undefined> = [];
    const coordinator = createAccountAffinityCoordinator((sessionId) => closed.push(sessionId));
    const one = await coordinator.acquire("one");
    one.beforeAttempt("a");
    const two = await coordinator.acquire("two");
    two.beforeAttempt("b");
    const queued = coordinator.acquire("one");

    coordinator.shutdown();
    await expect(queued).rejects.toThrow("Account affinity coordinator shut down");
    expect(closed.sort()).toEqual(["one", "two"]);
    coordinator.shutdown();
    expect(closed.sort()).toEqual(["one", "two"]);
    one.release();
    two.release();
  });

  test("shutdown clears all tracked sessions even when one close fails", async () => {
    const closed: string[] = [];
    const coordinator = createAccountAffinityCoordinator((sessionId) => {
      if (!sessionId) return;
      closed.push(sessionId);
      if (sessionId === "one") throw new Error("synthetic shutdown close failure");
    });
    const one = await coordinator.acquire("one");
    const two = await coordinator.acquire("two");
    const queued = coordinator.acquire("one");

    expect(() => coordinator.shutdown()).toThrow("synthetic shutdown close failure");
    await expect(queued).rejects.toThrow("Account affinity coordinator shut down");
    expect(closed).toEqual(["one", "two"]);
    coordinator.shutdown();
    expect(closed).toEqual(["one", "two"]);
    one.release();
    two.release();
  });
});
