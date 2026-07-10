import { describe, expect, test } from "bun:test";
import type { OAuthCredentials } from "@earendil-works/pi-ai/oauth";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { performCodexLogin } from "../../src/commands/login.ts";
import { makeCredentials } from "../fixtures/oauth.ts";

describe("Codex command login", () => {
  test("maps OAuth URL and prompt callbacks without shelling out", async () => {
    const notices: string[] = [];
    const added: Array<{ label: string; credentials: OAuthCredentials }> = [];
    const ctx = {
      ui: {
        notify: (message: string) => notices.push(message),
        input: async () => "manual-code",
      },
    } as unknown as ExtensionCommandContext;
    const result = await performCodexLogin({
      ctx,
      label: "work",
      vault: {
        addFromOAuth: async (label, credentials) => {
          added.push({ label, credentials });
          return "codex-a";
        },
      },
      login: async (callbacks) => {
        callbacks.onAuth({ url: "https://example.test/oauth", instructions: "Sign in" });
        expect(await callbacks.onPrompt({ message: "Code?" })).toBe("manual-code");
        return makeCredentials("account-1", 3_000_000_000_000);
      },
    });
    expect(result).toBe("Added Codex account work (codex-a)");
    expect(notices).toEqual(["Sign in: https://example.test/oauth"]);
    expect(added).toHaveLength(1);
  });
});
