import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const repository = join(import.meta.dir, "../..");

describe("private repository documentation", () => {
  test("describes installation as private everywhere", async () => {
    const troubleshooting = await readFile(join(repository, "docs/troubleshooting.md"), "utf8");

    expect(troubleshooting).toContain("private SSH or authenticated HTTPS install");
    expect(troubleshooting).not.toContain("public HTTPS Git source");
  });

  test("does not advertise unavailable vulnerability reporting", async () => {
    const [readme, security] = await Promise.all([
      readFile(join(repository, "README.md"), "utf8"),
      readFile(join(repository, "SECURITY.md"), "utf8"),
    ]);

    expect(security).toContain("does not currently publish a vulnerability-reporting channel");
    expect(security).not.toContain("/security/advisories/new");
    expect(readme).toContain("current reporting availability");
    expect(readme).not.toContain("private reporting route");
  });
});
