import { loginOpenAICodex, type OAuthCredentials } from "@earendil-works/pi-ai/oauth";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AccountVault } from "../accounts/account-vault.ts";
import { sanitizeDisplay } from "../logging/redact.ts";

type LoginOptions = Parameters<typeof loginOpenAICodex>[0];

export async function performCodexLogin(options: {
  ctx: ExtensionCommandContext;
  label?: string;
  vault: Pick<AccountVault, "addFromOAuth">;
  login?: (options: LoginOptions) => Promise<OAuthCredentials>;
}): Promise<string> {
  const credentials = await (options.login ?? loginOpenAICodex)({
    originator: "pi-quota-router",
    onAuth: ({ url, instructions }) => {
      options.ctx.ui.notify(`${instructions ?? "Complete login in your browser"}: ${url}`, "info");
    },
    onPrompt: async ({ message, placeholder }) => {
      const value = await options.ctx.ui.input(message, placeholder);
      if (value === undefined) {
        throw new Error("Codex login was cancelled");
      }
      return value;
    },
  });
  const label = sanitizeDisplay(options.label ?? "Codex account") || "Codex account";
  const id = await options.vault.addFromOAuth(label, credentials);
  return `Added Codex account ${label} (${id})`;
}
