import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function createStorageFixture(): Promise<{
  directory: string;
  file: string;
  cleanup: () => Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), "pi-quota-router-"));
  return {
    directory,
    file: join(directory, "nested", "state.json"),
    cleanup: () => rm(directory, { force: true, recursive: true }),
  };
}
