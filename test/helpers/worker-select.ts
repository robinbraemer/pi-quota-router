import { defaultConfig } from "../../src/config.ts";
import { selectAndReserve } from "../../src/routing/select-and-reserve.ts";
import { createAtomicJsonStore } from "../../src/storage/atomic-json-store.ts";
import {
  defaultRuntimeState,
  type RuntimeStateFile,
  RuntimeStateFileSchema,
} from "../../src/storage/schemas.ts";
import { candidate } from "../fixtures/candidates.ts";

const [statePath, requestId] = process.argv.slice(2);
if (!statePath || !requestId) {
  throw new Error("state path and request id are required");
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
    candidates: [candidate("a", now), candidate("b", now)],
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
process.stdout.write(result.reservation?.accountId ?? "none");
