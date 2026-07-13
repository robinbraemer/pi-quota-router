import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const repository = join(import.meta.dir, "../..");

describe("distribution CI", () => {
  test("uses a local Git install smoke outside trusted main pushes", async () => {
    const [workflow, smokeInstall] = await Promise.all([
      readFile(join(repository, ".github/workflows/ci.yml"), "utf8"),
      readFile(join(repository, "scripts/smoke-install.ts"), "utf8"),
    ]);

    expect(workflow).toContain("Smoke-test Pi's local Git install path");
    expect(workflow).toContain("Smoke-test Pi's authenticated GitHub install path");
    expect(workflow).toContain(
      "if: github.event_name == 'push' && github.ref == 'refs/heads/main'",
    );
    expect(workflow).toContain('GIT_CONFIG_COUNT: "1"');
    expect(workflow).toMatch(
      /GIT_CONFIG_KEY_0: url\.https:\/\/x-access-token:\$\{\{ github\.token \}\}@github\.com\/\.insteadOf/,
    );
    expect(workflow).toContain("GIT_CONFIG_VALUE_0: https://github.com/");
    expect(smokeInstall).toContain("createLocalGitSource");
    expect(smokeInstall).not.toContain(
      'process.env.PI_QUOTA_ROUTER_GIT_SOURCE ??\n  "git:https://github.com/robinbraemer/pi-quota-router.git"',
    );
  });
});
