import { homedir } from "node:os";
import { join } from "node:path";

export interface RouterPaths {
  directory: string;
  accounts: string;
  config: string;
  state: string;
  log: string;
}

export function resolveRouterPaths(
  agentDirectory = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
): RouterPaths {
  const directory = join(agentDirectory, "pi-quota-router");
  return {
    directory,
    accounts: join(directory, "accounts.json"),
    config: join(directory, "config.json"),
    state: join(directory, "state.json"),
    log: join(directory, "events.ndjson"),
  };
}
