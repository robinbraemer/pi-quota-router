import { describe, expect, test } from "bun:test";
import type { OAuthCredentials } from "@earendil-works/pi-ai/oauth";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { performCodexLogin } from "../../src/commands/login.ts";
import { makeCredentials } from "../fixtures/oauth.ts";

const AUTHORIZATION_URL =
  "https://auth.openai.com/oauth/authorize?response_type=code&client_id=codex-test&state=oauth-state";
const OPEN_ACTION = "Open authorization URL in default browser";
const COPY_ACTION = "Copy authorization URL";
const MANUAL_ACTION = "Show authorization URL for manual use";

describe("Codex command login", () => {
  test("offers explicit actions and opens only the validated authorization URL", async () => {
    const harness = createLoginHarness(OPEN_ACTION);

    await performCodexLogin({
      ...harness.options,
      actions: {
        open: async (url) => harness.opened.push(url),
        copy: async (url) => harness.copied.push(url),
      },
    });
    await Bun.sleep(0);

    expect(harness.selectors).toEqual([
      {
        title: "Codex authorization",
        options: [OPEN_ACTION, COPY_ACTION, MANUAL_ACTION],
      },
    ]);
    expect(harness.opened).toEqual([AUTHORIZATION_URL]);
    expect(harness.copied).toEqual([]);
    expect(harness.notices.join("\n")).toContain(AUTHORIZATION_URL);
  });

  test("copies only the validated authorization URL", async () => {
    const harness = createLoginHarness(COPY_ACTION);

    await performCodexLogin({
      ...harness.options,
      actions: {
        open: async (url) => harness.opened.push(url),
        copy: async (url) => harness.copied.push(url),
      },
    });
    await Bun.sleep(0);

    expect(harness.opened).toEqual([]);
    expect(harness.copied).toEqual([AUTHORIZATION_URL]);
    expect(harness.copied.join(" ")).not.toContain(harness.credentials.access);
    expect(harness.copied.join(" ")).not.toContain(harness.credentials.refresh);
  });

  test("races an abortable manual-code prompt with the browser callback", async () => {
    const harness = createLoginHarness(COPY_ACTION);
    let manualSignal: AbortSignal | undefined;
    harness.ctx.ui.input = async (_message, _placeholder, dialogOptions) => {
      manualSignal = dialogOptions?.signal;
      return "manual-code";
    };

    await performCodexLogin({
      ...harness.options,
      login: async (callbacks) => {
        callbacks.onAuth({ url: AUTHORIZATION_URL });
        expect(await callbacks.onManualCodeInput?.()).toBe("manual-code");
        return harness.credentials;
      },
    });

    expect(manualSignal).toBeDefined();
    expect(manualSignal?.aborted).toBe(true);
  });

  test("preserves the visible URL when actions fail or selection is unavailable", async () => {
    for (const selection of [OPEN_ACTION, COPY_ACTION, new Error("no selector")]) {
      const harness = createLoginHarness(selection);

      await performCodexLogin({
        ...harness.options,
        actions: {
          open: async () => {
            throw new Error("no browser");
          },
          copy: async () => {
            throw new Error("no clipboard");
          },
        },
      });
      await Bun.sleep(0);

      expect(harness.notices.at(-1)).toContain(AUTHORIZATION_URL);
      expect(harness.noticeTypes.at(-1)).toBe("warning");
    }
  });

  test("preserves a manual fallback when interactive selection is unavailable", async () => {
    const harness = createLoginHarness(undefined);
    delete (harness.ctx.ui as Partial<ExtensionCommandContext["ui"]>).select;

    await performCodexLogin(harness.options);

    expect(harness.notices.at(-1)).toContain(AUTHORIZATION_URL);
    expect(harness.noticeTypes.at(-1)).toBe("warning");
  });

  test("rejects unsafe authorization URLs before launch, copy, or persistence", async () => {
    const harness = createLoginHarness(OPEN_ACTION, "javascript:alert(document.cookie)");

    await expect(performCodexLogin(harness.options)).rejects.toThrow(
      "Unexpected Codex authorization URL",
    );

    expect(harness.selectors).toEqual([]);
    expect(harness.opened).toEqual([]);
    expect(harness.copied).toEqual([]);
    expect(harness.added).toEqual([]);
    expect(harness.notices.join(" ")).not.toContain("document.cookie");
  });

  test("rejects credential-bearing or incomplete authorization URLs", async () => {
    for (const url of [
      "https://user:password@auth.openai.com/oauth/authorize?response_type=code&client_id=codex-test&state=oauth-state",
      "https://auth.openai.com/oauth/authorize?response_type=code&client_id=codex-test",
      "https://auth.openai.com/oauth/authorize?response_type=code&client_id=codex-test&state=oauth-state#injected",
    ]) {
      const harness = createLoginHarness(OPEN_ACTION, url);
      await expect(performCodexLogin(harness.options)).rejects.toThrow(
        "Unexpected Codex authorization URL",
      );
      expect(harness.added).toEqual([]);
    }
  });
});

function createLoginHarness(
  selection: string | undefined | Error | Promise<string | undefined>,
  url = AUTHORIZATION_URL,
) {
  const notices: string[] = [];
  const noticeTypes: Array<string | undefined> = [];
  const selectors: Array<{ title: string; options: string[] }> = [];
  const opened: string[] = [];
  const copied: string[] = [];
  const added: Array<{ label: string; credentials: OAuthCredentials }> = [];
  const credentials = makeCredentials("account-1", 3_000_000_000_000);
  const ctx = {
    ui: {
      notify: (message: string, type?: string) => {
        notices.push(message);
        noticeTypes.push(type);
      },
      select: async (title: string, options: string[]) => {
        selectors.push({ title, options });
        if (selection instanceof Error) throw selection;
        return await selection;
      },
      input: async () => "manual-code",
    },
  } as unknown as ExtensionCommandContext;
  return {
    ctx,
    notices,
    noticeTypes,
    selectors,
    opened,
    copied,
    added,
    credentials,
    options: {
      ctx,
      label: "work",
      vault: {
        addFromOAuth: async (label: string, oauthCredentials: OAuthCredentials) => {
          added.push({ label, credentials: oauthCredentials });
          return "codex-a";
        },
      },
      login: async (
        callbacks: Parameters<NonNullable<Parameters<typeof performCodexLogin>[0]["login"]>>[0],
      ) => {
        callbacks.onAuth({ url, instructions: "Provider-controlled instructions" });
        expect(await callbacks.onPrompt({ message: "Code?" })).toBe("manual-code");
        return credentials;
      },
    },
  };
}
