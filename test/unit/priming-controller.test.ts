import { afterEach, describe, expect, test } from "bun:test";
import { defaultConfig } from "../../src/config.ts";
import {
  createPrimingController,
  type PrimerRequest,
} from "../../src/priming/priming-controller.ts";
import { createReservationStore } from "../../src/routing/reservation-store.ts";
import { createAtomicJsonStore } from "../../src/storage/atomic-json-store.ts";
import {
  defaultRuntimeState,
  type RuntimeStateFile,
  RuntimeStateFileSchema,
} from "../../src/storage/schemas.ts";
import type { UsageSnapshot } from "../../src/types.ts";
import { createStorageFixture } from "../fixtures/storage.ts";

const NOW = 2_000_000_000_000;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

function untouched(weeklyReset?: number): UsageSnapshot {
  return {
    accountId: "a",
    observedAt: NOW,
    shortWindow: { usedPercent: 0, resetsAt: NOW + 18_000_000 },
    weeklyWindow: {
      usedPercent: 0,
      ...(weeklyReset ? { resetsAt: weeklyReset } : {}),
    },
    stale: false,
  };
}

async function setup(options?: {
  authorized?: boolean;
  refreshed?: UsageSnapshot;
  execute?: (request: PrimerRequest, signal: AbortSignal) => Promise<void>;
  accountIds?: string[];
  listError?: Error;
  onBackgroundError?: (error: unknown) => void;
  reservationTtlMs?: number;
  clock?: () => number;
}) {
  const fixture = await createStorageFixture();
  cleanups.push(fixture.cleanup);
  const store = createAtomicJsonStore<RuntimeStateFile>({
    path: fixture.file,
    schema: RuntimeStateFileSchema,
    createDefault: () => structuredClone(defaultRuntimeState),
  });
  const requests: PrimerRequest[] = [];
  let reads = 0;
  const controller = createPrimingController({
    config: () => ({
      ...defaultConfig,
      reservationTtlMs: options?.reservationTtlMs ?? defaultConfig.reservationTtlMs,
      priming: {
        ...defaultConfig.priming,
        enabled: options?.authorized ?? false,
        confirmedFirstUseRollingWindow: options?.authorized ?? false,
      },
    }),
    stateStore: store,
    reservations: createReservationStore(store),
    usage: {
      get: async () => {
        reads += 1;
        return reads === 1 ? untouched() : (options?.refreshed ?? untouched());
      },
    },
    listAccountIds: async () => {
      if (options?.listError) {
        throw options.listError;
      }
      return options?.accountIds ?? ["a"];
    },
    executePrimer: async (request, signal) => {
      requests.push(request);
      await options?.execute?.(request, signal);
    },
    clock: options?.clock ?? (() => NOW),
    owner: { processId: 1, sessionId: "s", requestId: "primer" },
    currentModelId: () => "gpt-test",
    lowestReasoning: () => "minimal",
    ...(options?.onBackgroundError ? { onBackgroundError: options.onBackgroundError } : {}),
  });
  return { controller, store, requests };
}

describe("PrimingController", () => {
  test("does not spend quota without both confirmations", async () => {
    const { controller, requests } = await setup();
    expect(await controller.primeAccount("a")).toEqual({ status: "not_authorized" });
    expect(requests).toHaveLength(0);
  });

  test("allows one explicitly authorized attempt without enabling background sweeps", async () => {
    const { controller, requests } = await setup({
      refreshed: untouched(NOW + 604_800_000),
    });

    expect(await controller.primeAccount("a", { authorization: "one-shot" })).toEqual({
      status: "confirmed",
      resetAt: NOW + 604_800_000,
    });
    expect(requests).toHaveLength(1);

    controller.scheduleSweep("idle");
    await Bun.sleep(10);
    await controller.shutdown();
    expect(requests).toHaveLength(1);
  });

  test("sends the minimal isolated request and confirms only an observed reset", async () => {
    const { controller, store, requests } = await setup({
      authorized: true,
      refreshed: untouched(NOW + 604_800_000),
    });
    expect(await controller.primeAccount("a")).toEqual({
      status: "confirmed",
      resetAt: NOW + 604_800_000,
    });
    expect(requests).toEqual([
      {
        accountId: "a",
        modelId: "gpt-test",
        prompt: ".",
        messages: [],
        tools: [],
        reasoning: "minimal",
        maxTokens: 1,
      },
    ]);
    expect((await store.read()).priming.confirmedAccountIds).toEqual(["a"]);
    expect((await store.read()).reservations).toHaveLength(0);
  });

  test("applies a one-hour retry after an inconclusive primer", async () => {
    const { controller, store } = await setup({ authorized: true });
    expect(await controller.primeAccount("a")).toEqual({ status: "inconclusive" });
    expect((await store.read()).priming.retryAfter.a).toBe(NOW + 3_600_000);
  });

  test("does not start while foreground work is active", async () => {
    const { controller, requests } = await setup({ authorized: true });
    controller.setForegroundActive(true);
    expect(await controller.primeAccount("a")).toEqual({ status: "busy" });
    expect(requests).toHaveLength(0);
  });

  test("applies the sweep limit to primer attempts instead of account positions", async () => {
    const { controller, store, requests } = await setup({
      authorized: true,
      accountIds: ["a", "b"],
      refreshed: untouched(NOW + 604_800_000),
    });
    await store.update((state) => ({
      ...state,
      priming: { ...state.priming, confirmedAccountIds: ["a"] },
    }));

    controller.scheduleSweep("idle");
    await waitUntil(() => requests.length === 1);
    await controller.shutdown();

    expect(requests[0]?.accountId).toBe("b");
  });

  test("reports unexpected detached sweep failures", async () => {
    const errors: unknown[] = [];
    const failure = new Error("list failed");
    const { controller } = await setup({
      authorized: true,
      listError: failure,
      onBackgroundError: (error) => errors.push(error),
    });

    controller.scheduleSweep("idle");
    await waitUntil(() => errors.length === 1);
    await controller.shutdown();

    expect(errors).toEqual([failure]);
  });

  test("handles foreground cancellation of a detached primer", async () => {
    const errors: unknown[] = [];
    let started = false;
    const { controller } = await setup({
      authorized: true,
      onBackgroundError: (error) => errors.push(error),
      execute: async (_request, signal) => {
        started = true;
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    });

    controller.scheduleSweep("idle");
    await waitUntil(() => started);
    controller.setForegroundActive(true);
    await Bun.sleep(10);
    await controller.shutdown();

    expect(errors).toEqual([]);
  });

  test("renews primer leases for the full primer request", async () => {
    let finishPrimer: () => void = () => undefined;
    const primerHeld = new Promise<void>((resolve) => {
      finishPrimer = resolve;
    });
    const { controller, store } = await setup({
      authorized: true,
      reservationTtlMs: 600,
      clock: Date.now,
      execute: async () => primerHeld,
    });

    const result = controller.primeAccount("a");
    await waitUntilAsync(async () => (await store.read()).reservations.length === 2);
    const initialExpiry = Math.max(
      ...(await store.read()).reservations.map((reservation) => reservation.expiresAt),
    );
    await waitUntilAsync(async () => {
      const reservations = (await store.read()).reservations;
      return (
        reservations.length === 2 &&
        reservations.every((reservation) => reservation.expiresAt > initialExpiry)
      );
    });

    finishPrimer();
    await result;
    expect((await store.read()).reservations).toEqual([]);
  });
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await Bun.sleep(2);
  }
  throw new Error("condition was not reached");
}

async function waitUntilAsync(predicate: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await predicate()) {
      return;
    }
    await Bun.sleep(10);
  }
  throw new Error("condition was not reached");
}
