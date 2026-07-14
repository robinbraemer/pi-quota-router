import { describe, expect, test } from "bun:test";

describe("public hygiene release check", () => {
  test("accepts the repository's public documentation", async () => {
    const child = Bun.spawn([process.execPath, "run", "scripts/check-public-hygiene.ts"], {
      cwd: `${import.meta.dir}/../..`,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(exitCode, `${stdout}${stderr}`.trim()).toBe(0);
  });
});
