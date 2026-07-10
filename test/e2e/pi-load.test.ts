import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { OPENAI_CODEX_MODELS } from "@earendil-works/pi-ai/providers/openai-codex.models";
import { createIsolatedPiHome } from "../helpers/isolated-home.ts";

setDefaultTimeout(30_000);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

describe("normal Pi extension load", () => {
  test("loads from the package entry and preserves every Codex model", async () => {
    const home = await createIsolatedPiHome();
    cleanups.push(home.cleanup);
    const pi = fileURLToPath(new URL("../../node_modules/.bin/pi", import.meta.url));
    const process = Bun.spawn([pi, "-e", "./src/index.ts", "--list-models", "openai-codex"], {
      cwd: new URL("../..", import.meta.url).pathname,
      env: home.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    for (const modelId of Object.keys(OPENAI_CODEX_MODELS)) {
      expect(stdout).toContain(modelId);
    }
    expect(stdout.match(/^openai-codex\s+/gm)).toHaveLength(
      Object.keys(OPENAI_CODEX_MODELS).length,
    );
  });
});
