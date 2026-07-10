import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface SecretScanInput {
  path: string;
  content: string;
}

export interface SecretLeak {
  path: string;
  line: number;
  kind: string;
}

const patterns: Array<{ kind: string; pattern: RegExp }> = [
  { kind: "bearer token", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{24,}/gi },
  { kind: "refresh token", pattern: /\b(?:rt|refresh)[_-][A-Za-z0-9._~+/=-]{24,}\b/g },
  { kind: "OpenAI API key", pattern: /\bsk-[A-Za-z0-9_-]{24,}\b/g },
  {
    kind: "JWT",
    pattern: /\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
];

export function findSecretLeaks(inputs: SecretScanInput[]): SecretLeak[] {
  const leaks: SecretLeak[] = [];
  for (const input of inputs) {
    for (const { kind, pattern } of patterns) {
      pattern.lastIndex = 0;
      for (const match of input.content.matchAll(pattern)) {
        leaks.push({
          path: input.path,
          line: lineNumber(input.content, match.index),
          kind,
        });
      }
    }
  }
  return leaks.sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.line - right.line ||
      left.kind.localeCompare(right.kind),
  );
}

if (import.meta.main) {
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const tracked = await trackedFiles(repository);
  const testOutput = await captureTestOutput(repository);
  const inputs: SecretScanInput[] = [];
  for (const path of tracked) {
    const content = await readFile(resolve(repository, path), "utf8").catch(() => "");
    if (!content.includes("\0")) inputs.push({ path, content });
  }
  inputs.push({ path: "<bun-test-output>", content: testOutput });

  const leaks = findSecretLeaks(inputs);
  if (leaks.length > 0) {
    for (const leak of leaks) {
      console.error(`${leak.path}:${leak.line}: possible ${leak.kind}`);
    }
    throw new Error(`Secret scan found ${leaks.length} possible credential leak(s)`);
  }
  console.log(`Secret scan passed (${tracked.length} tracked files plus Bun test output).`);
}

function lineNumber(content: string, index = 0): number {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (content.charCodeAt(cursor) === 10) line += 1;
  }
  return line;
}

async function trackedFiles(repository: string): Promise<string[]> {
  const output = await run(["git", "ls-files", "-z"], repository);
  return output.split("\0").filter(Boolean);
}

async function captureTestOutput(repository: string): Promise<string> {
  return run([process.execPath, "test"], repository, {
    ...process.env,
    NO_COLOR: "1",
    FORCE_COLOR: "0",
  });
}

async function run(
  command: string[],
  cwd: string,
  env: Record<string, string | undefined> = process.env,
): Promise<string> {
  const child = Bun.spawn(command, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    process.stderr.write(stdout);
    process.stderr.write(stderr);
    throw new Error(`${command.join(" ")} failed with exit ${exitCode}`);
  }
  return `${stdout}${stderr}`;
}
