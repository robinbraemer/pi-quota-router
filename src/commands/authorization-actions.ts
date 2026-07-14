import { spawn } from "node:child_process";

export interface AuthorizationActions {
  open(url: string): Promise<void>;
  copy(url: string): Promise<void>;
}

const AUTHORIZATION_ORIGIN = "https://auth.openai.com";
const AUTHORIZATION_PATH = "/oauth/authorize";
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_REDIRECT_URI = "http://localhost:1455/auth/callback";

export function validateAuthorizationUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Unexpected Codex authorization URL");
  }
  if (
    url.origin !== AUTHORIZATION_ORIGIN ||
    url.pathname !== AUTHORIZATION_PATH ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    !hasSingleSearchParam(url, "response_type", "code") ||
    !hasSingleSearchParam(url, "client_id", CODEX_CLIENT_ID) ||
    !hasSingleSearchParam(url, "redirect_uri", CODEX_REDIRECT_URI) ||
    !hasSingleSearchParam(url, "code_challenge_method", "S256") ||
    !isPkceChallenge(url.searchParams.getAll("code_challenge")) ||
    !hasSingleNonemptySearchParam(url, "state")
  ) {
    throw new Error("Unexpected Codex authorization URL");
  }
  return url.toString();
}

function hasSingleSearchParam(url: URL, name: string, expected: string): boolean {
  const values = url.searchParams.getAll(name);
  return values.length === 1 && values[0] === expected;
}

function hasSingleNonemptySearchParam(url: URL, name: string): boolean {
  const values = url.searchParams.getAll(name);
  return values.length === 1 && values[0] !== "";
}

function isPkceChallenge(values: string[]): boolean {
  return values.length === 1 && /^[A-Za-z0-9_-]{43,128}$/.test(values[0] ?? "");
}

export const defaultAuthorizationActions: AuthorizationActions = {
  async open(url) {
    const [command, args] = browserCommand(url);
    await launch(command, args);
  },
  async copy(url) {
    const candidates = clipboardCommands();
    let lastError: unknown;
    for (const [command, args] of candidates) {
      try {
        await writeToProcess(command, args, url);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Clipboard is unavailable");
  },
};

function browserCommand(url: string): [string, string[]] {
  switch (process.platform) {
    case "darwin":
      return ["open", [url]];
    case "win32":
      return ["rundll32.exe", ["url.dll,FileProtocolHandler", url]];
    case "linux":
      return ["xdg-open", [url]];
    default:
      throw new Error(`Opening a browser is unavailable on ${process.platform}`);
  }
}

function clipboardCommands(): Array<[string, string[]]> {
  switch (process.platform) {
    case "darwin":
      return [["pbcopy", []]];
    case "win32":
      return [["clip.exe", []]];
    case "linux":
      return [
        ["wl-copy", []],
        ["xclip", ["-selection", "clipboard"]],
        ["xsel", ["--clipboard", "--input"]],
      ];
    default:
      return [];
  }
}

function launch(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    // The validated URL is always one argv entry. No provider-controlled value is parsed by a shell.
    const child = spawn(command, args, {
      detached: true,
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function writeToProcess(command: string, args: string[], input: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Clipboard tools receive the validated URL on stdin, never in a shell command string.
    const child = spawn(command, args, {
      shell: false,
      stdio: ["pipe", "ignore", "ignore"],
      windowsHide: true,
    });
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error("Clipboard action failed"));
    };
    child.once("error", fail);
    child.stdin?.once("error", fail);
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with status ${String(code)}`));
      }
    });
    child.stdin?.end(input);
  });
}
