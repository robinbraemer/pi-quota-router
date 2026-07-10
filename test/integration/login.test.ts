import { describe, expect, test } from "bun:test";
import type { OAuthCredentials } from "@earendil-works/pi-ai/oauth";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { performCodexLogin } from "../../src/commands/login.ts";
import { makeCredentials } from "../fixtures/oauth.ts";

const AUTH_URL = "https://example.test/oauth";
const OPEN_ACTION = "Open authorization URL in default browser";
const COPY_ACTION = "Copy authorization URL";
const MANUAL_ACTION = "Continue manually (URL shown above)";

describe("Codex command login", () => {
  test("saves completed OAuth credentials while the handoff selector remains open", async () => {
    let resolveSelection: ((selection: string | undefined) => void) | undefined;
    const selection = new Promise<string | undefined>((resolve) => {
      resolveSelection = resolve;
    });
    const setup = loginFixture(selection);

    const result = await Promise.race([
      performCodexLogin(setup.options),
      Bun.sleep(100).then(() => {
        throw new Error("login waited for authorization selector");
      }),
    ]);

    expect(result.id).toBe("codex-a");
    expect(setup.added).toHaveLength(1);
    resolveSelection?.(MANUAL_ACTION);
  });

  test("opens the authorization URL selected by the user", async () => {
    const opened: string[] = [];
    const copied: string[] = [];
    const setup = loginFixture(OPEN_ACTION);

    const result = await performCodexLogin({
      ...setup.options,
      openUrl: async (url: string) => {
        opened.push(url);
      },
      copyUrl: async (url: string) => {
        copied.push(url);
      },
    });

    expect(setup.selections).toEqual([
      {
        title: "OpenAI Codex authorization",
        options: [OPEN_ACTION, COPY_ACTION, MANUAL_ACTION],
      },
    ]);
    expect(opened).toEqual([AUTH_URL]);
    expect(copied).toEqual([]);
    expect(setup.notices[0]).toContain(AUTH_URL);
    expect(result).toEqual({
      id: "codex-a",
      label: "work",
      message: "Added Codex account work (codex-a)",
    });
  });

  test("copies the authorization URL selected by the user", async () => {
    const copied: string[] = [];
    const setup = loginFixture(COPY_ACTION);

    await performCodexLogin({
      ...setup.options,
      openUrl: async () => undefined,
      copyUrl: async (url: string) => {
        copied.push(url);
      },
    });

    expect(copied).toEqual([AUTH_URL]);
    expect(setup.notices).toContain("Authorization URL copied to the clipboard.");
  });

  test("keeps the visible URL as a manual fallback on manual or cancelled selection", async () => {
    for (const selection of [MANUAL_ACTION, undefined]) {
      const opened: string[] = [];
      const copied: string[] = [];
      const setup = loginFixture(selection);

      await performCodexLogin({
        ...setup.options,
        openUrl: async (url: string) => {
          opened.push(url);
        },
        copyUrl: async (url: string) => {
          copied.push(url);
        },
      });

      expect(opened).toEqual([]);
      expect(copied).toEqual([]);
      expect(setup.notices.join("\n")).toContain(AUTH_URL);
      expect(setup.notices.at(-1)).toContain("manually");
    }
  });

  test("falls back to the visible URL when browser, clipboard, or selector is unavailable", async () => {
    for (const scenario of [
      { selection: OPEN_ACTION, failure: new Error("no browser") },
      { selection: COPY_ACTION, failure: new Error("no clipboard") },
      { selection: new Error("no selector"), failure: undefined },
    ]) {
      const setup = loginFixture(scenario.selection);

      await performCodexLogin({
        ...setup.options,
        openUrl: async () => {
          if (scenario.failure) throw scenario.failure;
        },
        copyUrl: async () => {
          if (scenario.failure) throw scenario.failure;
        },
      });

      expect(setup.notices.at(-1)).toContain(AUTH_URL);
      expect(setup.noticeTypes.at(-1)).toBe("warning");
    }
  });
});

function loginFixture(selection: string | undefined | Error | Promise<string | undefined>) {
  const notices: string[] = [];
  const noticeTypes: Array<string | undefined> = [];
  const selections: Array<{ title: string; options: string[] }> = [];
  const added: Array<{ label: string; credentials: OAuthCredentials }> = [];
  const ctx = {
    ui: {
      notify: (message: string, type?: string) => {
        notices.push(message);
        noticeTypes.push(type);
      },
      select: async (title: string, options: string[]) => {
        selections.push({ title, options });
        if (selection instanceof Error) throw selection;
        return await selection;
      },
      input: async () => "manual-code",
    },
  } as unknown as ExtensionCommandContext;
  return {
    notices,
    noticeTypes,
    selections,
    added,
    options: {
      ctx,
      label: "work",
      vault: {
        addFromOAuth: async (label: string, credentials: OAuthCredentials) => {
          added.push({ label, credentials });
          return "codex-a";
        },
      },
      login: async (
        callbacks: Parameters<typeof performCodexLogin>[0]["login"] extends infer T
          ? T extends (...args: infer _Args) => unknown
            ? Parameters<T>[0]
            : never
          : never,
      ) => {
        callbacks.onAuth({ url: AUTH_URL, instructions: "Sign in" });
        expect(await callbacks.onPrompt({ message: "Code?" })).toBe("manual-code");
        return makeCredentials("account-1", 3_000_000_000_000);
      },
    },
  };
}
