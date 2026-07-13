import { describe, expect, test } from "bun:test";

describe("public hygiene release check", () => {
  test("accepts the repository's public documentation", async () => {
    const child = Bun.spawn([process.execPath, "run", "scripts/check-public-hygiene.ts"], {
      cwd: `${import.meta.dir}/../..`,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(await child.exited).toBe(0);
  });
});
