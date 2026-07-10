import { describe, expect, test } from "bun:test";
import {
  CodexUsageHttpError,
  CodexUsageParseError,
  fetchCodexUsage,
  parseCodexUsage,
} from "../../src/usage/codex-usage.ts";
import { completeUsageResponse, primaryOnlyUsageResponse } from "../fixtures/usage-responses.ts";

describe("Codex usage", () => {
  test("parses active windows and normalizes reset units", () => {
    const snapshot = parseCodexUsage(completeUsageResponse, 2_000_000_000_000, "codex-a");
    expect(snapshot).toEqual({
      accountId: "codex-a",
      observedAt: 2_000_000_000_000,
      shortWindow: { usedPercent: 12.5, resetsAt: 2_000_000_100_000 },
      weeklyWindow: { usedPercent: 37, resetsAt: 2_000_604_800_000 },
      stale: false,
      planType: "pro",
      creditsRemaining: 42,
    });
  });

  test("preserves a missing weekly window instead of inventing one", () => {
    const snapshot = parseCodexUsage(primaryOnlyUsageResponse, 1, "codex-a");
    expect(snapshot.weeklyWindow).toBeUndefined();
    expect(snapshot.shortWindow.usedPercent).toBe(0);
  });

  test("clamps percentages and rejects a missing primary window", () => {
    const snapshot = parseCodexUsage(
      {
        rate_limit: {
          primary_window: { used_percent: 140, reset_at: 2_000_000_100 },
          secondary_window: { used_percent: -5, reset_at: 2_000_000_200 },
        },
      },
      1,
      "codex-a",
    );
    expect(snapshot.shortWindow.usedPercent).toBe(100);
    expect(snapshot.weeklyWindow?.usedPercent).toBe(0);
    expect(() => parseCodexUsage({}, 1, "codex-a")).toThrow(CodexUsageParseError);
  });

  test("sends credentials only in the expected ChatGPT headers", async () => {
    let request: Request | undefined;
    const snapshot = await fetchCodexUsage({
      accessToken: "secret-access",
      accountId: "raw-account",
      managedAccountId: "codex-a",
      clock: () => 123,
      fetchImpl: async (input, init) => {
        request = new Request(input, init);
        return Response.json(completeUsageResponse);
      },
    });

    expect(request?.url).toBe("https://chatgpt.com/backend-api/wham/usage");
    expect(request?.headers.get("authorization")).toBe("Bearer secret-access");
    expect(request?.headers.get("chatgpt-account-id")).toBe("raw-account");
    expect(snapshot.accountId).toBe("codex-a");
    expect(JSON.stringify(snapshot)).not.toContain("secret-access");
  });

  test("returns typed status and timeout failures without credentials", async () => {
    await expect(
      fetchCodexUsage({
        accessToken: "secret-access",
        accountId: "raw-account",
        managedAccountId: "codex-a",
        fetchImpl: async () => new Response("limited", { status: 429 }),
      }),
    ).rejects.toEqual(expect.objectContaining({ status: 429 }));

    try {
      await fetchCodexUsage({
        accessToken: "secret-access",
        accountId: "raw-account",
        managedAccountId: "codex-a",
        timeoutMs: 5,
        fetchImpl: (_input, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
              once: true,
            });
          }),
      });
      throw new Error("expected timeout");
    } catch (error) {
      expect(error).toBeInstanceOf(CodexUsageHttpError);
      expect((error as Error).message).not.toContain("secret-access");
      expect((error as Error).message).not.toContain("raw-account");
    }
  });
});
