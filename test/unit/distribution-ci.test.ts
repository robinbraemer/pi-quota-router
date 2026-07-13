import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const repository = join(import.meta.dir, "../..");

describe("distribution CI", () => {
  test("uses credential-free public HTTPS Git install smoke on pull requests and main", async () => {
    const [workflow, smokeInstall] = await Promise.all([
      readFile(join(repository, ".github/workflows/ci.yml"), "utf8"),
      readFile(join(repository, "scripts/smoke-install.ts"), "utf8"),
    ]);

    expect(workflow).toContain("Smoke-test Pi's local Git install path");
    const publicSmoke = workflow.match(
      /- name: Smoke-test Pi's public HTTPS Git install path[\s\S]*?run: bun run smoke:install/,
    )?.[0];
    expect(publicSmoke).toBeDefined();
    expect(publicSmoke).toContain(
      "if: github.event_name == 'pull_request' || (github.event_name == 'push' && github.ref == 'refs/heads/main')",
    );
    expect(publicSmoke).toContain(
      `PI_QUOTA_ROUTER_GIT_REVISION: \${{ github.event.pull_request.head.sha || github.sha }}`,
    );
    expect(workflow).not.toContain("x-access-token:");
    expect(workflow).not.toContain("github.token");
    expect(workflow).toContain('PI_QUOTA_ROUTER_CREDENTIAL_FREE: "1"');
    expect(smokeInstall).toContain("createLocalGitSource");
    expect(smokeInstall).not.toContain(
      'process.env.PI_QUOTA_ROUTER_GIT_SOURCE ??\n  "git:https://github.com/robinbraemer/pi-quota-router.git"',
    );
    expect(smokeInstall).toContain("PI_QUOTA_ROUTER_CREDENTIAL_FREE");
    expect(smokeInstall).toContain('GIT_CONFIG_NOSYSTEM: "1"');
    expect(smokeInstall).toContain('GIT_CONFIG_GLOBAL: "/dev/null"');
    expect(smokeInstall).toContain('GIT_CONFIG_KEY_0: "credential.helper"');
  });
});
