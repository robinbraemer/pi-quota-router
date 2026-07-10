import { afterEach, describe, expect, test } from "bun:test";
import { chmod, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import { z } from "zod";
import {
  createAtomicJsonStore,
  lockTargetFor,
  StoreLockTimeoutError,
  StoreValidationError,
} from "../../src/storage/atomic-json-store.ts";
import { createStorageFixture } from "../fixtures/storage.ts";

const schema = z
  .object({
    version: z.literal(1),
    value: z.number().int(),
  })
  .strict();

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function fixture() {
  const value = await createStorageFixture();
  cleanups.push(value.cleanup);
  return value;
}

describe("AtomicJsonStore", () => {
  test("creates private directories and files", async () => {
    const { file } = await fixture();
    const store = createAtomicJsonStore({
      path: file,
      schema,
      createDefault: () => ({ version: 1 as const, value: 0 }),
    });

    expect(await store.read()).toEqual({ version: 1, value: 0 });

    const directoryMode = (await stat(dirname(file))).mode & 0o777;
    const fileMode = (await stat(file)).mode & 0o777;
    expect(directoryMode).toBe(0o700);
    expect(fileMode).toBe(0o600);
  });

  test("keeps the valid primary when a write fails before rename", async () => {
    const { file } = await fixture();
    const stable = createAtomicJsonStore({
      path: file,
      schema,
      createDefault: () => ({ version: 1 as const, value: 0 }),
    });
    await stable.update((current) => ({ ...current, value: 1 }));

    const interrupted = createAtomicJsonStore({
      path: file,
      schema,
      createDefault: () => ({ version: 1 as const, value: 0 }),
      hooks: {
        beforeRename: () => {
          throw new Error("simulated interruption");
        },
      },
    });

    await expect(interrupted.update((current) => ({ ...current, value: 2 }))).rejects.toThrow(
      "simulated interruption",
    );
    expect(await stable.read()).toEqual({ version: 1, value: 1 });
  });

  test("reports invalid persisted data without overwriting it", async () => {
    const { file } = await fixture();
    const store = createAtomicJsonStore({
      path: file,
      schema,
      createDefault: () => ({ version: 1 as const, value: 0 }),
    });
    await store.read();
    await writeFile(file, '{"version":1,"value":"wrong"}\n', { mode: 0o600 });

    await expect(store.read()).rejects.toBeInstanceOf(StoreValidationError);
  });

  test("serializes concurrent updates without losing writes", async () => {
    const { file } = await fixture();
    const first = createAtomicJsonStore({
      path: file,
      schema,
      createDefault: () => ({ version: 1 as const, value: 0 }),
    });
    const second = createAtomicJsonStore({
      path: file,
      schema,
      createDefault: () => ({ version: 1 as const, value: 0 }),
    });

    await first.read();
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        (index % 2 === 0 ? first : second).update(async (current) => {
          await Bun.sleep(index % 3);
          return { ...current, value: current.value + 1 };
        }),
      ),
    );

    expect(await first.read()).toEqual({ version: 1, value: 12 });
  });

  test("ignores abandoned temporary files when the primary is valid", async () => {
    const { file } = await fixture();
    const store = createAtomicJsonStore({
      path: file,
      schema,
      createDefault: () => ({ version: 1 as const, value: 0 }),
    });
    await store.update((current) => ({ ...current, value: 4 }));
    await writeFile(`${file}.abandoned.tmp`, '{"version":1,"value":99}\n');

    expect(await store.read()).toEqual({ version: 1, value: 4 });
  });

  test("returns a visible error when the lock cannot be acquired", async () => {
    const { file } = await fixture();
    const store = createAtomicJsonStore({
      path: file,
      schema,
      createDefault: () => ({ version: 1 as const, value: 0 }),
      lockTimeoutMs: 20,
    });
    await store.read();
    const lockTarget = lockTargetFor(file);
    await chmod(lockTarget, 0o600);
    const release = await lockfile.lock(lockTarget, { realpath: false });

    try {
      await expect(store.update((current) => current)).rejects.toBeInstanceOf(
        StoreLockTimeoutError,
      );
    } finally {
      await release();
    }
  });
});
