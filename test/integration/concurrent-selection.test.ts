import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createStorageFixture } from "../fixtures/storage.ts";

const cleanups: Array<() => Promise<void>> = [];
setDefaultTimeout(30_000);

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("atomic select and reserve", () => {
  test("two processes reserve different accounts", async () => {
    const fixture = await createStorageFixture();
    cleanups.push(fixture.cleanup);
    const worker = new URL("../helpers/worker-select.ts", import.meta.url).pathname;
    const children = ["one", "two"].map((requestId) =>
      Bun.spawn([process.execPath, worker, fixture.file, requestId], {
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    const outputs = await Promise.all(
      children.map(async (child) => {
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect(stderr).toBe("");
        expect(exitCode).toBe(0);
        return stdout;
      }),
    );

    expect(outputs.sort()).toEqual(["a", "b"]);
  });
});
