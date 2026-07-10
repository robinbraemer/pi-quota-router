import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createReservationStore } from "../../src/routing/reservation-store.ts";
import { createAtomicJsonStore } from "../../src/storage/atomic-json-store.ts";
import {
  defaultRuntimeState,
  type RuntimeStateFile,
  RuntimeStateFileSchema,
} from "../../src/storage/schemas.ts";
import { createStorageFixture } from "../fixtures/storage.ts";

const NOW = 2_000_000_000_000;
const cleanups: Array<() => Promise<void>> = [];
setDefaultTimeout(30_000);

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function setup() {
  const fixture = await createStorageFixture();
  cleanups.push(fixture.cleanup);
  const store = createAtomicJsonStore<RuntimeStateFile>({
    path: fixture.file,
    schema: RuntimeStateFileSchema,
    createDefault: () => structuredClone(defaultRuntimeState),
  });
  return { store, reservations: createReservationStore(store) };
}

describe("ReservationStore", () => {
  test("releases only the matching opaque lease token", async () => {
    const { store, reservations } = await setup();
    await store.update((state) => ({
      ...state,
      reservations: [
        {
          accountId: "a",
          leaseToken: "right",
          owner: { processId: 1, sessionId: "s", requestId: "r" },
          createdAt: NOW,
          expiresAt: NOW + 1000,
          kind: "foreground",
        },
      ],
    }));

    expect(await reservations.release("wrong")).toBe(false);
    expect((await store.read()).reservations).toHaveLength(1);
    expect(await reservations.release("right")).toBe(true);
    expect((await store.read()).reservations).toHaveLength(0);
  });

  test("removes expired leases and keeps live leases", async () => {
    const { store, reservations } = await setup();
    await store.update((state) => ({
      ...state,
      reservations: [
        {
          accountId: "expired",
          leaseToken: "expired",
          owner: { processId: 1, sessionId: "s", requestId: "old" },
          createdAt: NOW - 2000,
          expiresAt: NOW - 1,
          kind: "foreground",
        },
        {
          accountId: "live",
          leaseToken: "live",
          owner: { processId: 1, sessionId: "s", requestId: "new" },
          createdAt: NOW,
          expiresAt: NOW + 1000,
          kind: "foreground",
        },
      ],
    }));

    expect(await reservations.cleanupExpired(NOW)).toBe(1);
    expect((await store.read()).reservations.map((value) => value.accountId)).toEqual(["live"]);
  });

  test("allows only one live singleton primer sweep", async () => {
    const { reservations } = await setup();
    const owner = { processId: 1, sessionId: "s", requestId: "prime-1" };
    const first = await reservations.acquirePrimerSweep(owner, NOW, 1000);
    const second = await reservations.acquirePrimerSweep(
      { ...owner, requestId: "prime-2" },
      NOW,
      1000,
    );

    expect(first).toBeDefined();
    expect(second).toBeUndefined();
  });
});
