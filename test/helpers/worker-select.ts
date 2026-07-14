import { access, appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { defaultConfig } from "../../src/config.ts";
import { selectAndReserve } from "../../src/routing/select-and-reserve.ts";
import { createAtomicJsonStore } from "../../src/storage/atomic-json-store.ts";
import {
  defaultRuntimeState,
  type RuntimeStateFile,
  RuntimeStateFileSchema,
} from "../../src/storage/schemas.ts";
import { candidate } from "../fixtures/candidates.ts";

interface WorkerSelectionResult {
  accountId?: string;
  leaseToken?: string;
  foregroundActiveBefore?: number;
}

const [statePath, requestId, accountIdsCsv = "a", holdAfterSelect = "false"] =
  process.argv.slice(2);
if (!statePath || !requestId) {
  throw new Error("state path and request id are required");
}
const accountIds = accountIdsCsv.split(",").filter((accountId) => accountId.length > 0);
const diagnosticPath = process.env.PI_QUOTA_ROUTER_TEST_DIAGNOSTIC_PATH;
const diagnosticStartedAt = process.hrtime.bigint();
const diagnostic = async (stage: string, detail?: Record<string, number | string | boolean>) => {
  if (!diagnosticPath) return;
  await appendFile(
    diagnosticPath,
    `${JSON.stringify({
      source: "child",
      stage,
      elapsedMs: Number(process.hrtime.bigint() - diagnosticStartedAt) / 1_000_000,
      processId: process.pid,
      ...detail,
    })}\n`,
    "utf8",
  );
};
await diagnostic("helper-entered");
const startBarrier = process.env.PI_QUOTA_ROUTER_TEST_START_BARRIER;
if (startBarrier) {
  await mkdir(dirname(startBarrier), { recursive: true });
  await writeFile(`${startBarrier}.${requestId}.ready`, "ready", "utf8");
  while (
    !(await access(startBarrier)
      .then(() => true)
      .catch(() => false))
  ) {
    await Bun.sleep(1);
  }
}
await diagnostic("start-barrier-cleared");
const now = 2_000_000_000_000;
const store = createAtomicJsonStore<RuntimeStateFile>({
  path: statePath,
  schema: RuntimeStateFileSchema,
  createDefault: () => structuredClone(defaultRuntimeState),
});
await diagnostic("atomic-store-open-start");
await store.read();
await diagnostic("atomic-store-open-complete");
await diagnostic("selection-lock-start");
const result = await selectAndReserve({
  stateStore: store,
  request: {
    candidates: accountIds.map((accountId) => candidate(accountId, now)),
    config: defaultConfig,
    now,
  },
  owner: {
    processId: process.pid,
    sessionId: "worker",
    requestId,
  },
  now,
});
await diagnostic("selection-lock-complete");
const output: WorkerSelectionResult = {
  ...(result.reservation
    ? {
        accountId: result.reservation.accountId,
        leaseToken: result.reservation.leaseToken,
      }
    : {}),
  ...(result.foregroundActiveBefore !== undefined
    ? { foregroundActiveBefore: result.foregroundActiveBefore }
    : {}),
};
await diagnostic("json-write-start");
process.stdout.write(`${JSON.stringify(output)}\n`);
await diagnostic("json-write-complete");
if (holdAfterSelect === "true") {
  await new Promise<void>((resolve) => {
    process.once("SIGTERM", resolve);
    process.once("SIGINT", resolve);
  });
}
