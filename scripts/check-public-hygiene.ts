import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const artifactPath =
  /\bdocs\/(?:superpowers|tasks?|plans?|specs?|evidence|reports?|transcripts?)(?:\/|\b)/gi;

interface HygieneViolation {
  path: string;
  line?: number;
  message: string;
}

if (import.meta.main) {
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const violations = await findPublicHygieneViolations(repository);
  if (violations.length > 0) {
    for (const violation of violations) {
      const location =
        violation.line === undefined ? violation.path : `${violation.path}:${violation.line}`;
      console.error(`${location}: ${violation.message}`);
    }
    throw new Error(`Public hygiene check found ${violations.length} violation(s)`);
  }
  console.log("Public hygiene check passed.");
}

export async function findPublicHygieneViolations(repository: string): Promise<HygieneViolation[]> {
  const violations: HygieneViolation[] = [];
  for (const path of await trackedFiles(repository)) {
    if (path.startsWith("docs/superpowers/")) {
      violations.push({
        path,
        message: "tracked docs/superpowers artifacts are not public product content",
      });
      continue;
    }
    if (!isPublicDocumentation(path)) continue;

    const content = await readFile(resolve(repository, path), "utf8");
    for (const match of content.matchAll(artifactPath)) {
      violations.push({
        path,
        line: lineNumber(content, match.index),
        message: `public documentation references an internal artifact path (${match[0]})`,
      });
    }
  }
  return violations;
}

function isPublicDocumentation(path: string): boolean {
  return path === "README.md" || path.startsWith("docs/");
}

async function trackedFiles(repository: string): Promise<string[]> {
  const child = Bun.spawn(["git", "ls-files", "-z"], {
    cwd: repository,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, output, errors] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`git ls-files failed with exit ${exitCode}: ${errors}`);
  return output.split("\0").filter(Boolean);
}

function lineNumber(content: string, index = 0): number {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (content.charCodeAt(cursor) === 10) line += 1;
  }
  return line;
}
