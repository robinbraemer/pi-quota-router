import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OPENAI_CODEX_MODELS } from "@earendil-works/pi-ai/providers/openai-codex.models";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source =
  process.env.PI_QUOTA_ROUTER_GIT_SOURCE ?? "git:git@github.com:robinbraemer/pi-quota-router";
const root = await mkdtemp(join(tmpdir(), "pi-quota-router-github-smoke-"));
const agentDirectory = join(root, "agent");
const project = join(root, "project");

try {
  const revision = (
    await run(["git", "rev-parse", process.env.PI_QUOTA_ROUTER_GIT_REVISION ?? "HEAD"], repository)
  ).trim();
  const remoteRefs = await run(["git", "ls-remote", "origin"], repository);
  if (!remoteRefs.includes(revision)) {
    throw new Error(
      `HEAD ${revision.slice(0, 12)} is not pushed to origin; the GitHub install smoke only tests published commits`,
    );
  }

  await mkdir(project, { recursive: true });
  const env = {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDirectory,
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes -o ConnectTimeout=10",
  };
  const pinnedSource = `${source}@${revision}`;
  await run([piExecutable(), "install", pinnedSource, "--no-approve"], project, env);
  const installed = await run([piExecutable(), "--list-models", "openai-codex"], project, env);

  for (const modelId of Object.keys(OPENAI_CODEX_MODELS)) {
    if (!installed.includes(modelId)) {
      throw new Error(`GitHub-installed extension did not expose Codex model ${modelId}`);
    }
  }
  const listedModels = installed.match(/^openai-codex\s+/gm)?.length ?? 0;
  if (listedModels !== Object.keys(OPENAI_CODEX_MODELS).length) {
    throw new Error(
      `Expected ${Object.keys(OPENAI_CODEX_MODELS).length} Codex models, found ${listedModels}`,
    );
  }

  const packageRoot = await findInstalledPackage(agentDirectory);
  for (const path of await sourceFiles(join(packageRoot, "src"))) {
    const content = await readFile(path, "utf8");
    if (
      content.includes("/packages/coding-agent/src/") ||
      content.includes("/tmp/pi-mono") ||
      content.includes("node_modules/@earendil-works/pi-coding-agent/src/")
    ) {
      throw new Error(`Private Pi source path found in ${path}`);
    }
  }

  console.log(`GitHub install smoke passed for ${pinnedSource} (${listedModels} Codex models).`);
} finally {
  await rm(root, { recursive: true, force: true });
}

function piExecutable(): string {
  return process.env.PI_EXECUTABLE ?? join(repository, "node_modules", ".bin", "pi");
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
    throw new Error(`${command.join(" ")} failed with exit ${exitCode}\n${stdout}${stderr}`.trim());
  }
  return stdout;
}

async function findInstalledPackage(directory: string): Promise<string> {
  for (const entry of await readdir(directory, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || entry.name !== "package.json") continue;
    const path = join(entry.parentPath, entry.name);
    const parsed = JSON.parse(await readFile(path, "utf8")) as { name?: string };
    if (parsed.name === "@robinbraemer/pi-quota-router") return entry.parentPath;
  }
  throw new Error("Pi did not install @robinbraemer/pi-quota-router under the isolated profile");
}

async function sourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && /\.(?:ts|js|json)$/.test(entry.name)) {
      files.push(join(entry.parentPath, entry.name));
    }
  }
  return files;
}
