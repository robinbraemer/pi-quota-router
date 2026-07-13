import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const repository = join(import.meta.dir, "../..");

describe("public repository documentation", () => {
  test("keeps the public Git package contract catalog-ready without claiming publication", async () => {
    const [readme, security, troubleshooting, packageJson, extension] = await Promise.all([
      readFile(join(repository, "README.md"), "utf8"),
      readFile(join(repository, "SECURITY.md"), "utf8"),
      readFile(join(repository, "docs/troubleshooting.md"), "utf8"),
      readFile(join(repository, "package.json"), "utf8"),
      readFile(join(repository, "src/index.ts"), "utf8"),
    ]);
    const metadata = JSON.parse(packageJson) as Record<string, unknown>;

    expect(readme).toContain("pi install https://github.com/robinbraemer/pi-quota-router.git");
    expect(readme).toContain("not yet published to npm");
    expect(readme).toContain("not listed in the pi.dev Package Catalog");
    expect(readme).not.toContain("This private repository");
    expect(readme).not.toContain("You need repository access");
    expect(troubleshooting).toContain("public HTTPS Git install");
    expect(troubleshooting).not.toContain("private SSH or authenticated HTTPS install");
    expect(security).toContain("This public repository");
    expect(security).toContain("does not currently publish a vulnerability-reporting channel");
    expect(security).not.toContain("/security/advisories/new");
    expect(metadata.license).toBe("MIT");
    expect(metadata.repository).toEqual({
      type: "git",
      url: "git+https://github.com/robinbraemer/pi-quota-router.git",
    });
    expect(metadata.homepage).toBe("https://github.com/robinbraemer/pi-quota-router#readme");
    expect(metadata.bugs).toBe("https://github.com/robinbraemer/pi-quota-router/issues");
    expect(metadata.publishConfig).toEqual({ access: "public" });
    expect(metadata.keywords).toEqual(expect.arrayContaining(["pi-package"]));
    expect(metadata.files).toEqual(expect.arrayContaining(["src"]));
    expect(metadata.pi).toEqual({ extensions: ["./src/index.ts"] });
    expect(extension).not.toHaveLength(0);
  });

  test("keeps intentional local credential-vault privacy wording", async () => {
    const securityModel = await readFile(join(repository, "docs/security.md"), "utf8");

    expect(securityModel).toContain("private lock target");
    expect(securityModel).toContain("credential, config, state, log, lock-target, temporary");
  });
});
