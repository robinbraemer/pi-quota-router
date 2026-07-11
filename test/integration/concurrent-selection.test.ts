import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { access, readFile, writeFile } from "node:fs/promises";
import { RuntimeStateFileSchema } from "../../src/storage/schemas.ts";
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
