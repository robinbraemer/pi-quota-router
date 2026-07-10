import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function createIsolatedPiHome() {
  const root = await mkdtemp(join(tmpdir(), "pi-quota-router-home-"));
  const agentDirectory = join(root, "agent");
  return {
    root,
    agentDirectory,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDirectory,
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
