import { afterEach, describe, expect, test } from "bun:test";
import { RecoveryWaitTimeoutError, waitForRecovery } from "../../src/recovery/wait-for-recovery.ts";
import { createAtomicJsonStore } from "../../src/storage/atomic-json-store.ts";
import {
  defaultRuntimeState,
  type RuntimeStateFile,
  RuntimeStateFileSchema,
} from "../../src/storage/schemas.ts";
import { createStorageFixture } from "../fixtures/storage.ts";

const START = 2_000_000_000_000;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function setup(retryAt: number) {
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
        blockedAt: START,
        retryAt,
        estimated: true,
      },
    ],
  }));
  return store;
}

describe("waitForRecovery", () => {
  test("rechecks persisted state and wakes when a peer clears it", async () => {
    let now = START;
    const store = await setup(START + 3_600_000);
    let sleeps = 0;
    await waitForRecovery({
      stateStore: store,
      clock: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
        sleeps += 1;
        await store.update((state) => ({ ...state, blocks: [] }));
      },
    });
    expect(sleeps).toBe(1);
  });

  test("caps waiting at six hours", async () => {
    let now = START;
    const store = await setup(START + 36_000_000);
    await expect(
      waitForRecovery({
        stateStore: store,
        clock: () => now,
        recheckMs: 3_600_000,
        sleep: async (milliseconds) => {
          now += milliseconds;
        },
      }),
    ).rejects.toBeInstanceOf(RecoveryWaitTimeoutError);
  });

  test("honors caller abort before sleeping", async () => {
    const store = await setup(START + 3_600_000);
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(
      waitForRecovery({
        stateStore: store,
        clock: () => START,
        signal: controller.signal,
        sleep: async () => undefined,
      }),
    ).rejects.toThrow("cancelled");
  });
});
