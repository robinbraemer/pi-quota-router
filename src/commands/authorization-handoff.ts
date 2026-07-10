import { spawn } from "node:child_process";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { copyToClipboard } from "@earendil-works/pi-coding-agent";

export const OPEN_AUTHORIZATION_URL = "Open authorization URL in default browser";
export const COPY_AUTHORIZATION_URL = "Copy authorization URL";
export const CONTINUE_AUTHORIZATION_MANUALLY = "Continue manually (URL shown above)";

const ACTIONS = [OPEN_AUTHORIZATION_URL, COPY_AUTHORIZATION_URL, CONTINUE_AUTHORIZATION_MANUALLY];

export async function presentAuthorizationHandoff(options: {
  ui: Pick<ExtensionUIContext, "select" | "notify">;
  url: string;
  instructions?: string;
  openUrl?: (url: string) => Promise<void>;
  copyUrl?: (url: string) => Promise<void>;
}): Promise<void> {
  options.ui.notify(
    `${options.instructions ?? "Complete OpenAI Codex authorization"}\nAuthorization URL: ${options.url}`,
    "info",
  );

  let action: string | undefined;
  try {
    action = await options.ui.select("OpenAI Codex authorization", ACTIONS);
  } catch {
    options.ui.notify(
      `Authorization selector unavailable. Continue manually: ${options.url}`,
      "warning",
    );
    return;
  }

  if (action === OPEN_AUTHORIZATION_URL) {
    try {
      await (options.openUrl ?? openDefaultBrowser)(options.url);
      options.ui.notify("Authorization URL opened in the default browser.", "info");
    } catch {
      options.ui.notify(
        `Could not open the default browser. Continue manually: ${options.url}`,
        "warning",
      );
    }
    return;
  }

  if (action === COPY_AUTHORIZATION_URL) {
    try {
      await (options.copyUrl ?? copyToClipboard)(options.url);
      options.ui.notify("Authorization URL copied to the clipboard.", "info");
    } catch {
      options.ui.notify(
        `Could not copy the authorization URL. Continue manually: ${options.url}`,
        "warning",
      );
    }
    return;
  }

  options.ui.notify(`Continue manually with this authorization URL: ${options.url}`, "warning");
}

async function openDefaultBrowser(target: string): Promise<void> {
  const [command, args]: [string, string[]] =
    process.platform === "darwin"
      ? ["open", [target]]
      : process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", target]]
        : ["xdg-open", [target]];

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
