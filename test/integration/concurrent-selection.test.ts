import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { access, readFile, writeFile } from "node:fs/promises";
import { defaultConfig } from "../../src/config.ts";
import { createPrimingController } from "../../src/priming/priming-controller.ts";
import { createReservationStore } from "../../src/routing/reservation-store.ts";
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
setDefaultTimeout(30_000);

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("atomic select and reserve", () => {
  test("two processes append distinct foreground leases for one account", async () => {
    const fixture = await createStorageFixture();
    cleanups.push(fixture.cleanup);
    const outputs = await runWorkers(fixture.file, ["one", "two"]);

    expect(outputs.map((value) => value.accountId)).toEqual(["a", "a"]);
    expect(new Set(outputs.map((value) => value.leaseToken)).size).toBe(2);
    const state = RuntimeStateFileSchema.parse(JSON.parse(await readFile(fixture.file, "utf8")));
    expect(state.reservations.filter((value) => value.accountId === "a")).toHaveLength(2);
  });

  test("eight processes append without lost updates or malformed state", async () => {
    const fixture = await createStorageFixture();
    cleanups.push(fixture.cleanup);
    const requestIds = Array.from({ length: 8 }, (_, index) => `worker-${index}`);
    const outputs = await runWorkers(fixture.file, requestIds);

    expect(outputs.every((value) => value.accountId === "a")).toBeTrue();
    expect(new Set(outputs.map((value) => value.leaseToken)).size).toBe(8);
    const state = RuntimeStateFileSchema.parse(JSON.parse(await readFile(fixture.file, "utf8")));
    const liveForeground = state.reservations.filter(
      (value) => value.accountId === "a" && value.kind === "foreground" && value.expiresAt > NOW,
    );
    expect(liveForeground).toHaveLength(8);
    expect(new Set(liveForeground.map((value) => value.leaseToken)).size).toBe(8);
  });

  test("a crashed foreground worker stays as a primer fence but not a foreground veto", async () => {
    const fixture = await createStorageFixture();
    cleanups.push(fixture.cleanup);
    const worker = new URL("../helpers/worker-select.ts", import.meta.url).pathname;
    const child = Bun.spawn([process.execPath, worker, fixture.file, "crashed", "a", "true"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const reader = child.stdout.getReader();
    const stderr = new Response(child.stderr).text();
    let crashed: WorkerSelectionResult;
    try {
      const line = await Promise.race([
        readLine(reader),
        Bun.sleep(5_000).then(() => {
          throw new Error("crash worker timed out before selection");
        }),
      ]);
      crashed = JSON.parse(line) as WorkerSelectionResult;
    } finally {
      child.kill();
      await child.exited;
      await reader.cancel().catch(() => undefined);
    }
    expect(await stderr).toBe("");
    if (!crashed.leaseToken) throw new Error("crashed worker did not return a lease token");
    const second = await runWorkers(fixture.file, ["after-crash"]);
    expect(second[0]?.accountId).toBe("a");
    const state = RuntimeStateFileSchema.parse(JSON.parse(await readFile(fixture.file, "utf8")));
    expect(state.reservations.map((value) => value.leaseToken)).toContain(crashed.leaseToken);
    expect(state.reservations).toHaveLength(2);

    const store = createAtomicJsonStore<RuntimeStateFile>({
      path: fixture.file,
      schema: RuntimeStateFileSchema,
      createDefault: () => structuredClone(defaultRuntimeState),
    });
    const reservations = createReservationStore(store);
    let now = NOW;
    let providerCalls = 0;
    const primer = createPrimingController({
      config: () => ({ ...defaultConfig, priming: { ...defaultConfig.priming, enabled: true } }),
      stateStore: store,
      reservations,
      usage: {
        get: async () => ({
          accountId: "a",
          observedAt: now,
          shortWindow: { usedPercent: 0, resetsAt: now + 18_000_000 },
          weeklyWindow: { usedPercent: 0 },
          stale: false,
        }),
      },
      listAccountIds: async () => ["a"],
      executePrimer: async () => {
        providerCalls += 1;
      },
      clock: () => now,
      owner: { processId: process.pid, sessionId: "primer", requestId: "primer" },
      currentModelId: () => "gpt-test",
      lowestReasoning: () => "minimal",
    });
    expect(await primer.primeAccount("a", { authorization: "one-shot" })).toEqual({
      status: "reserved",
    });
    if (!second[0]?.leaseToken) throw new Error("second worker did not return a lease token");
    await reservations.release(second[0].leaseToken);
    now = NOW + defaultConfig.reservationTtlMs + 1;
    expect(await reservations.cleanupExpired(now)).toBe(1);
    expect(await primer.primeAccount("a", { authorization: "one-shot" })).toEqual({
      status: "inconclusive",
    });
    expect(providerCalls).toBe(1);
    expect((await store.read()).reservations).toEqual([]);
    await primer.shutdown();
  });

  test("a dead-owner account primer blocks foreground until expiry", async () => {
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
        {
          accountId: "a",
          leaseToken: "dead-owner-primer",
          owner: { processId: 999_999, sessionId: "dead", requestId: "dead" },
          createdAt: NOW,
          expiresAt: NOW + 100,
          kind: "primer",
        },
      ],
    }));
    const select = (now: number) =>
      selectAndReserve({
        stateStore: store,
        request: { candidates: [candidate("a", now)], config: defaultConfig, now },
        owner: { processId: 1, sessionId: "foreground", requestId: `foreground-${now}` },
        now,
      });

    const blocked = await select(NOW);
    expect(blocked.reservation).toBeUndefined();
    expect(blocked.decision.candidates[0]?.rejectionCode).toBe("primer_active");
    const selected = await select(NOW + 101);
    expect(selected.reservation?.accountId).toBe("a");
    if (!selected.reservation) throw new Error("expected foreground selection after primer expiry");
    expect((await store.read()).reservations).toEqual([selected.reservation]);
  });
});

interface WorkerSelectionResult {
  accountId?: string;
  leaseToken?: string;
  foregroundActiveBefore?: number;
}

async function runWorkers(statePath: string, requestIds: string[]) {
  const worker = new URL("../helpers/worker-select.ts", import.meta.url).pathname;
  const barrierPath = `${statePath}.worker-start`;
  const children = requestIds.map((requestId) =>
    Bun.spawn([process.execPath, worker, statePath, requestId, "a", "false"], {
      env: { ...process.env, PI_QUOTA_ROUTER_TEST_START_BARRIER: barrierPath },
      stdout: "pipe",
      stderr: "pipe",
    }),
  );
  const results = children.map(async (child) => {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
  });
  const deadline = Date.now() + 5_000;
  try {
    while (
      !(await Promise.all(
        requestIds.map((requestId) =>
          access(`${barrierPath}.${requestId}.ready`)
            .then(() => true)
            .catch(() => false),
        ),
      ).then((ready) => ready.every(Boolean)))
    ) {
      if (children.some((child) => child.exitCode !== null) || Date.now() >= deadline) {
        for (const child of children) {
          if (child.exitCode === null) child.kill();
        }
        const diagnostics = await Promise.all(results);
        throw new Error(`workers failed before start barrier: ${JSON.stringify(diagnostics)}`);
      }
      await Bun.sleep(1);
    }
    await writeFile(barrierPath, "start", "utf8");
    return (await Promise.all(results)).map(({ exitCode, stdout, stderr }) => {
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      return JSON.parse(stdout) as WorkerSelectionResult;
    });
  } finally {
    for (const child of children) {
      if (child.exitCode === null) child.kill();
    }
    await Promise.all(children.map((child) => child.exited));
  }
}

async function readLine(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let buffered = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) throw new Error("worker stdout ended before a complete line");
    buffered += decoder.decode(value, { stream: true });
    const newline = buffered.indexOf("\n");
    if (newline >= 0) return buffered.slice(0, newline);
  }
}
