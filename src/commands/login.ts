import { loginOpenAICodex, type OAuthCredentials } from "@earendil-works/pi-ai/oauth";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AccountVault } from "../accounts/account-vault.ts";
import { sanitizeDisplay } from "../logging/redact.ts";
import { presentAuthorizationHandoff } from "./authorization-handoff.ts";

type LoginOptions = Parameters<typeof loginOpenAICodex>[0];
export type CodexLoginImplementation = (options: LoginOptions) => Promise<OAuthCredentials>;

export interface CodexLoginResult {
  id: string;
  label: string;
  message: string;
}

export async function performCodexLogin(options: {
  ctx: ExtensionCommandContext;
  label?: string;
  vault: Pick<AccountVault, "addFromOAuth">;
  login?: CodexLoginImplementation;
  openUrl?: (url: string) => Promise<void>;
  copyUrl?: (url: string) => Promise<void>;
}): Promise<CodexLoginResult> {
  const credentials = await (options.login ?? loginOpenAICodex)({
    originator: "pi-quota-router",
    onAuth: ({ url, instructions }) => {
      void presentAuthorizationHandoff({
        ui: options.ctx.ui,
        url,
        ...(instructions ? { instructions } : {}),
        ...(options.openUrl ? { openUrl: options.openUrl } : {}),
        ...(options.copyUrl ? { copyUrl: options.copyUrl } : {}),
      }).catch(() => undefined);
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
  return { id, label, message: `Added Codex account ${label} (${id})` };
}
