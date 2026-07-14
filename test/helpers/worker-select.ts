import { access, mkdir, writeFile } from "node:fs/promises";
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
const now = 2_000_000_000_000;
const store = createAtomicJsonStore<RuntimeStateFile>({
  path: statePath,
  schema: RuntimeStateFileSchema,
  createDefault: () => structuredClone(defaultRuntimeState),
});
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
process.stdout.write(`${JSON.stringify(output)}\n`);
if (holdAfterSelect === "true") {
  await new Promise<void>((resolve) => {
    process.once("SIGTERM", resolve);
    process.once("SIGINT", resolve);
  });
}
