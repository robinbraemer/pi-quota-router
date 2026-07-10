import { afterEach, describe, expect, test } from "bun:test";
import { defaultConfig } from "../../src/config.ts";
import { selectAndReserve } from "../../src/routing/select-and-reserve.ts";
import { createAtomicJsonStore } from "../../src/storage/atomic-json-store.ts";
import {
  defaultRuntimeState,
  type RuntimeStateFile,
  RuntimeStateFileSchema,
} from "../../src/storage/schemas.ts";
import { candidate } from "../fixtures/candidates.ts";
import { createStorageFixture } from "../fixtures/storage.ts";

const NOW = 2_000_000_000_000;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("selectAndReserve", () => {
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
