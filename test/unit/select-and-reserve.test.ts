import { afterEach, describe, expect, test } from "bun:test";
import { defaultConfig } from "../../src/config.ts";
import { selectAndReserve } from "../../src/routing/select-and-reserve.ts";
import { createAtomicJsonStore } from "../../src/storage/atomic-json-store.ts";
import {
  defaultRuntimeState,
  type RuntimeStateFile,
  RuntimeStateFileSchema,
} from "../../src/storage/schemas.ts";
import type { Reservation } from "../../src/types.ts";
import { candidate } from "../fixtures/candidates.ts";
import { createStorageFixture } from "../fixtures/storage.ts";

const NOW = 2_000_000_000_000;
const cleanups: Array<() => Promise<void>> = [];

function reservation(
  accountId: string,
  leaseToken: string,
  kind: Reservation["kind"],
): Reservation {
  return {
    accountId,
    leaseToken,
    owner: { processId: 2, sessionId: "peer-session", requestId: `peer-${leaseToken}` },
    createdAt: NOW,
    expiresAt: NOW + 60_000,
    kind,
  };
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("selectAndReserve", () => {
  test("appends a distinct foreground lease beside every live foreground peer", async () => {
    const fixture = await createStorageFixture();
    cleanups.push(fixture.cleanup);
    const store = createAtomicJsonStore<RuntimeStateFile>({
      path: fixture.file,
      schema: RuntimeStateFileSchema,
      createDefault: () => structuredClone(defaultRuntimeState),
    });
    await store.update((state) => ({
      ...state,
      reservations: [
        reservation("a", "synthetic-foreground-one", "foreground"),
        reservation("a", "synthetic-foreground-two", "foreground"),
      ],
    }));

    const result = await selectAndReserve({
      stateStore: store,
      request: { candidates: [candidate("a", NOW)], config: defaultConfig, now: NOW },
      owner: { processId: 1, sessionId: "session-a", requestId: "request-new" },
      now: NOW,
    });

    expect(result.reservation?.accountId).toBe("a");
    expect(result.foregroundActiveBefore).toBe(2);
    const state = await store.read();
    expect(state.reservations.filter((value) => value.accountId === "a")).toHaveLength(3);
    expect(new Set(state.reservations.map((value) => value.leaseToken)).size).toBe(3);
    expect(state.lastSelection?.candidates[0]?.rejectionCode).toBeUndefined();
  });

  test("rejects a live account primer and makes its expiry recoverable", async () => {
    const fixture = await createStorageFixture();
    cleanups.push(fixture.cleanup);
    const store = createAtomicJsonStore<RuntimeStateFile>({
      path: fixture.file,
      schema: RuntimeStateFileSchema,
      createDefault: () => structuredClone(defaultRuntimeState),
    });
    await store.update((state) => ({
      ...state,
      reservations: [reservation("a", "synthetic-primer", "primer")],
    }));

    const result = await selectAndReserve({
      stateStore: store,
      request: { candidates: [candidate("a", NOW)], config: defaultConfig, now: NOW },
      owner: { processId: 1, sessionId: "session-a", requestId: "request-new" },
      now: NOW,
    });

    expect(result.reservation).toBeUndefined();
    expect(result.foregroundActiveBefore).toBeUndefined();
    expect(result.decision.candidates[0]?.rejectionCode).toBe("primer_active");
    expect(result.recoverableAccountIds).toEqual(["a"]);
    expect((await store.read()).reservations).toHaveLength(1);
  });

  test("does not treat the primer sweep sentinel as an account veto", async () => {
    const fixture = await createStorageFixture();
    cleanups.push(fixture.cleanup);
    const store = createAtomicJsonStore<RuntimeStateFile>({
      path: fixture.file,
      schema: RuntimeStateFileSchema,
      createDefault: () => structuredClone(defaultRuntimeState),
    });
    await store.update((state) => ({
      ...state,
      reservations: [reservation("__primer_sweep__", "synthetic-sweep", "primer")],
    }));

    const result = await selectAndReserve({
      stateStore: store,
      request: { candidates: [candidate("a", NOW)], config: defaultConfig, now: NOW },
      owner: { processId: 1, sessionId: "session-a", requestId: "request-new" },
      now: NOW,
    });

    expect(result.reservation?.accountId).toBe("a");
    expect(result.foregroundActiveBefore).toBe(0);
  });

  test("manual routing ignores foreground activity but rejects an account primer", async () => {
    const fixture = await createStorageFixture();
    cleanups.push(fixture.cleanup);
    const store = createAtomicJsonStore<RuntimeStateFile>({
      path: fixture.file,
      schema: RuntimeStateFileSchema,
      createDefault: () => structuredClone(defaultRuntimeState),
    });
    await store.update((state) => ({
      ...state,
      reservations: [reservation("forced", "synthetic-foreground", "foreground")],
    }));
    const request = {
      candidates: [candidate("forced", NOW)],
      config: { ...defaultConfig, manualAccountId: "forced" },
      now: NOW,
    };

    const selected = await selectAndReserve({
      stateStore: store,
      request,
      owner: { processId: 1, sessionId: "session-a", requestId: "manual-foreground" },
      now: NOW,
    });
    expect(selected.reservation?.accountId).toBe("forced");
    expect(selected.foregroundActiveBefore).toBe(1);

    await store.update((state) => ({
      ...state,
      reservations: [reservation("forced", "synthetic-primer", "primer")],
    }));
    const rejected = await selectAndReserve({
      stateStore: store,
      request,
      owner: { processId: 1, sessionId: "session-a", requestId: "manual-primer" },
      now: NOW,
    });
    expect(rejected.decision.reason).toBe("manual_account_unavailable");
    expect(rejected.decision.candidates[0]?.rejectionCode).toBe("primer_active");
    expect(rejected.reservation).toBeUndefined();
  });

  test("overlays a block written after candidate usage was fetched", async () => {
    const fixture = await createStorageFixture();
    cleanups.push(fixture.cleanup);
    const store = createAtomicJsonStore<RuntimeStateFile>({
      path: fixture.file,
      schema: RuntimeStateFileSchema,
      createDefault: () => structuredClone(defaultRuntimeState),
    });
    await store.update((state) => ({
      ...state,
      blocks: [
        {
          accountId: "a",
          kind: "quota",
          blockedAt: NOW,
          retryAt: NOW + 1000,
          estimated: false,
        },
      ],
    }));

    const result = await selectAndReserve({
      stateStore: store,
      request: { candidates: [candidate("a", NOW)], config: defaultConfig, now: NOW },
      owner: { processId: 1, sessionId: "s", requestId: "r" },
      now: NOW,
    });

    expect(result.reservation).toBeUndefined();
    expect(result.recoverableAccountIds).toEqual(["a"]);
    expect(result.decision.candidates[0]?.rejectionCode).toBe("blocked");
  });

  test("does not mark policy-only rejection as recoverable", async () => {
    const fixture = await createStorageFixture();
    cleanups.push(fixture.cleanup);
    const store = createAtomicJsonStore<RuntimeStateFile>({
      path: fixture.file,
      schema: RuntimeStateFileSchema,
      createDefault: () => structuredClone(defaultRuntimeState),
    });
    await store.update((state) => ({
      ...state,
      blocks: [
        {
          accountId: "a",
          kind: "quota",
          blockedAt: NOW,
          retryAt: NOW + 1000,
          estimated: false,
        },
      ],
    }));

    const result = await selectAndReserve({
      stateStore: store,
      request: {
        candidates: [candidate("a", NOW, { untouched: true })],
        config: { ...defaultConfig, enabled: false },
        now: NOW,
      },
      owner: { processId: 1, sessionId: "s", requestId: "r" },
      now: NOW,
    });

    expect(result.reservation).toBeUndefined();
    expect(result.recoverableAccountIds).toEqual([]);
  });

  test("keeps excluded blocked accounts in recovery accounting", async () => {
    const fixture = await createStorageFixture();
    cleanups.push(fixture.cleanup);
    const store = createAtomicJsonStore<RuntimeStateFile>({
      path: fixture.file,
      schema: RuntimeStateFileSchema,
      createDefault: () => structuredClone(defaultRuntimeState),
    });
    await store.update((state) => ({
      ...state,
      blocks: [
        {
          accountId: "a",
          kind: "quota",
          blockedAt: NOW,
          retryAt: NOW + 1000,
          estimated: false,
        },
      ],
    }));

    const result = await selectAndReserve({
      stateStore: store,
      request: { candidates: [candidate("a", NOW)], config: defaultConfig, now: NOW },
      excludedAccountIds: new Set(["a"]),
      owner: { processId: 1, sessionId: "s", requestId: "r" },
      now: NOW,
    });

    expect(result.reservation).toBeUndefined();
    expect(result.recoverableAccountIds).toEqual(["a"]);
    expect(result.decision.candidates).toEqual([]);
  });

  test("recovers excluded accounts after their cooldown elapses", async () => {
    const fixture = await createStorageFixture();
    cleanups.push(fixture.cleanup);
    const store = createAtomicJsonStore<RuntimeStateFile>({
      path: fixture.file,
      schema: RuntimeStateFileSchema,
      createDefault: () => structuredClone(defaultRuntimeState),
    });
    await store.update((state) => ({
      ...state,
      blocks: [
        {
          accountId: "a",
          kind: "transient",
          blockedAt: NOW - 2000,
          retryAt: NOW - 1000,
          estimated: false,
        },
      ],
    }));

    const result = await selectAndReserve({
      stateStore: store,
      request: { candidates: [candidate("a", NOW)], config: defaultConfig, now: NOW },
      excludedAccountIds: new Set(["a"]),
      owner: { processId: 1, sessionId: "s", requestId: "r" },
      now: NOW,
    });

    expect(result.reservation).toBeUndefined();
    expect(result.recoverableAccountIds).toEqual(["a"]);
    expect(result.decision.candidates).toEqual([]);
  });

  test("does not recover blocked accounts when routing is disabled", async () => {
    const fixture = await createStorageFixture();
    cleanups.push(fixture.cleanup);
    const store = createAtomicJsonStore<RuntimeStateFile>({
      path: fixture.file,
      schema: RuntimeStateFileSchema,
      createDefault: () => structuredClone(defaultRuntimeState),
    });
    await store.update((state) => ({
      ...state,
      blocks: [
        {
          accountId: "a",
          kind: "quota",
          blockedAt: NOW,
          retryAt: NOW + 1000,
          estimated: false,
        },
      ],
    }));

    const result = await selectAndReserve({
      stateStore: store,
      request: {
        candidates: [candidate("a", NOW)],
        config: { ...defaultConfig, enabled: false },
        now: NOW,
      },
      owner: { processId: 1, sessionId: "s", requestId: "r" },
      now: NOW,
    });

    expect(result.recoverableAccountIds).toEqual([]);
  });

  test("only recovers the forced account during manual routing", async () => {
    const fixture = await createStorageFixture();
    cleanups.push(fixture.cleanup);
    const store = createAtomicJsonStore<RuntimeStateFile>({
      path: fixture.file,
      schema: RuntimeStateFileSchema,
      createDefault: () => structuredClone(defaultRuntimeState),
    });
    await store.update((state) => ({
      ...state,
      blocks: [
        {
          accountId: "forced",
          kind: "auth",
          blockedAt: NOW,
          estimated: false,
        },
        {
          accountId: "other",
          kind: "quota",
          blockedAt: NOW,
          retryAt: NOW + 1000,
          estimated: false,
        },
      ],
    }));

    const result = await selectAndReserve({
      stateStore: store,
      request: {
        candidates: [candidate("forced", NOW), candidate("other", NOW)],
        config: { ...defaultConfig, manualAccountId: "forced" },
        now: NOW,
      },
      owner: { processId: 1, sessionId: "s", requestId: "r" },
      now: NOW,
    });

    expect(result.reservation).toBeUndefined();
    expect(result.recoverableAccountIds).toEqual([]);
  });
});
