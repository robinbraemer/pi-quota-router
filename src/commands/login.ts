import { loginOpenAICodex, type OAuthCredentials } from "@earendil-works/pi-ai/oauth";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AccountVault } from "../accounts/account-vault.ts";
import { sanitizeDisplay } from "../logging/redact.ts";
import {
  type AuthorizationActions,
  defaultAuthorizationActions,
  validateAuthorizationUrl,
} from "./authorization-actions.ts";

type LoginOptions = Parameters<typeof loginOpenAICodex>[0];
export type CodexLoginImplementation = (options: LoginOptions) => Promise<OAuthCredentials>;

export interface CodexLoginResult {
  id: string;
  label: string;
  message: string;
}

class SafeCodexLoginError extends Error {}

export async function performCodexLogin(options: {
  ctx: ExtensionCommandContext;
  label?: string;
  vault: Pick<AccountVault, "addFromOAuth">;
  login?: CodexLoginImplementation;
  actions?: AuthorizationActions;
  openUrl?: (url: string) => Promise<void>;
  copyUrl?: (url: string) => Promise<void>;
  onAccountAdded?: (account: { id: string; label: string }) => Promise<void> | void;
}): Promise<CodexLoginResult> {
  let authorizationAction: Promise<void> | undefined;
  let authorizationError: SafeCodexLoginError | undefined;
  const manualPromptAbort = new AbortController();
  const fallbackActions = defaultAuthorizationActions;
  const actions =
    options.actions ??
    (options.openUrl || options.copyUrl
      ? {
          open: options.openUrl ?? fallbackActions.open,
          copy: options.copyUrl ?? fallbackActions.copy,
        }
      : fallbackActions);
  let credentials: OAuthCredentials;
  try {
    credentials = await (options.login ?? loginOpenAICodex)({
      originator: "pi-quota-router",
      onAuth: ({ url }) => {
        let validatedUrl: string;
        try {
          validatedUrl = validateAuthorizationUrl(url);
        } catch {
          authorizationError = new SafeCodexLoginError("Unexpected Codex authorization URL");
          return;
        }
        authorizationAction = presentAuthorizationActions(
          options.ctx,
          validatedUrl,
          actions,
          manualPromptAbort.signal,
        );
      },
      onPrompt: ({ message, placeholder }) =>
        promptForAuthorizationCode(options.ctx, message, placeholder),
      onManualCodeInput: async () => {
        if (authorizationError) {
          throw authorizationError;
        }
        await authorizationAction;
        return promptForAuthorizationCode(
          options.ctx,
          "Complete login in your browser, or paste the authorization code / redirect URL:",
          "http://localhost:1455/auth/callback",
          manualPromptAbort.signal,
        );
      },
    });
  } catch (error) {
    if (error instanceof SafeCodexLoginError) {
      throw error;
    }
    throw new SafeCodexLoginError("Codex login failed. Please try again.");
  } finally {
    manualPromptAbort.abort();
  }
  await authorizationAction;
  if (authorizationError) {
    throw authorizationError;
  }
  const label = sanitizeDisplay(options.label ?? "Codex account") || "Codex account";
  const id = await options.vault.addFromOAuth(label, credentials);
  await options.onAccountAdded?.({ id, label });
  return { id, label, message: `Added Codex account ${label} (${id})` };
}

const OPEN_ACTION = "Open authorization URL in default browser";
const COPY_ACTION = "Copy authorization URL";
const MANUAL_ACTION = "Show authorization URL for manual use";

async function presentAuthorizationActions(
  ctx: ExtensionCommandContext,
  url: string,
  actions: AuthorizationActions,
  signal: AbortSignal,
): Promise<void> {
  const select = ctx.ui.select;
  if (typeof select !== "function") {
    notifyManualFallback(
      ctx,
      "Browser and clipboard actions are unavailable. Open this authorization URL manually:",
      url,
    );
    return;
  }

  let selection: string | undefined;
  try {
    selection = await select.call(
      ctx.ui,
      "Codex authorization",
      [OPEN_ACTION, COPY_ACTION, MANUAL_ACTION],
      { signal },
    );
  } catch {
    if (signal.aborted) {
      return;
    }
    notifyManualFallback(
      ctx,
      "Browser and clipboard actions are unavailable. Open this authorization URL manually:",
      url,
    );
    return;
  }

  if (signal.aborted) {
    return;
  }

  if (selection === OPEN_ACTION) {
    try {
      await actions.open(url);
      ctx.ui.notify(
        `Authorization URL opened. If no browser appears, open it manually:\n${url}`,
        "info",
      );
    } catch {
      notifyManualFallback(ctx, "Could not open the authorization URL. Open it manually:", url);
    }
    return;
  }

  if (selection === COPY_ACTION) {
    try {
      await actions.copy(url);
      ctx.ui.notify(
        `Authorization URL copied. If the clipboard is unavailable, copy it manually:\n${url}`,
        "info",
      );
    } catch {
      notifyManualFallback(ctx, "Could not copy the authorization URL. Copy it manually:", url);
    }
    return;
  }

  notifyManualFallback(ctx, "Open this authorization URL manually:", url);
}

function notifyManualFallback(ctx: ExtensionCommandContext, message: string, url: string): void {
  ctx.ui.notify(`${message}\n${url}`, "warning");
}

async function promptForAuthorizationCode(
  ctx: ExtensionCommandContext,
  message: string,
  placeholder?: string,
  signal?: AbortSignal,
): Promise<string> {
  const value = await ctx.ui.input(message, placeholder, signal ? { signal } : undefined);
  if (value === undefined) {
    throw new SafeCodexLoginError("Codex login was cancelled");
  }
  return value;
}
