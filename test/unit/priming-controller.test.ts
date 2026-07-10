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
    listAccountIds: async () => ["a"],
    executePrimer: async (request, signal) => {
      requests.push(request);
      await options?.execute?.(request, signal);
    },
    clock: () => NOW,
    owner: { processId: 1, sessionId: "s", requestId: "primer" },
    currentModelId: () => "gpt-test",
    lowestReasoning: () => "minimal",
  });
  return { controller, store, requests };
}

describe("PrimingController", () => {
  test("does not spend quota without both confirmations", async () => {
    const { controller, requests } = await setup();
    expect(await controller.primeAccount("a")).toEqual({ status: "not_authorized" });
    expect(requests).toHaveLength(0);
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
});
