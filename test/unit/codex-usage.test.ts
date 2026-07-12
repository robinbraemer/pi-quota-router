import { describe, expect, test } from "bun:test";
import {
  CodexUsageHttpError,
  CodexUsageParseError,
  fetchCodexUsage,
  parseCodexUsage,
} from "../../src/usage/codex-usage.ts";
import {
  completeUsageResponse,
  primaryOnlyUsageResponse,
  reversedDurationUsageResponse,
  weeklyOnlyPrimaryUsageResponse,
} from "../fixtures/usage-responses.ts";

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
    expect(snapshot.shortWindow?.usedPercent).toBe(0);
  });

  test("classifies a duration-tagged primary weekly window without inventing short quota", () => {
    const snapshot = parseCodexUsage(weeklyOnlyPrimaryUsageResponse, 2_000_000_000_000, "codex-a");

    expect(snapshot.shortWindow).toBeUndefined();
    expect(snapshot.weeklyWindow).toEqual({
      usedPercent: 3,
      resetsAt: 2_000_604_800_000,
    });
  });

  test("uses recognized durations instead of primary and secondary position", () => {
    const snapshot = parseCodexUsage(reversedDurationUsageResponse, 2_000_000_000_000, "codex-a");

    expect(snapshot.shortWindow).toEqual({
      usedPercent: 10,
      resetsAt: 2_000_018_000_000,
    });
    expect(snapshot.weeklyWindow).toEqual({
      usedPercent: 30,
      resetsAt: 2_000_604_800_000,
    });
  });

  test("accepts camel-case RPC-compatible window metadata", () => {
    const snapshot = parseCodexUsage(
      {
        rate_limit: {
          primary_window: {
            usedPercent: 4,
            resetsAt: 2_000_604_800_000,
            windowDurationMins: 10_080,
          },
        },
      },
      2_000_000_000_000,
      "codex-a",
    );

    expect(snapshot).toEqual({
      accountId: "codex-a",
      observedAt: 2_000_000_000_000,
      weeklyWindow: { usedPercent: 4, resetsAt: 2_000_604_800_000 },
      stale: false,
    });
  });

  test("rejects unknown explicit durations and duplicate recognized kinds", () => {
    expect(() =>
      parseCodexUsage(
        {
          rate_limit: {
            primary_window: {
              used_percent: 1,
              reset_at: 2_000_001_000,
              limit_window_seconds: 1_000,
            },
          },
        },
        1,
        "codex-a",
      ),
    ).toThrow(CodexUsageParseError);

    expect(() =>
      parseCodexUsage(
        {
          rate_limit: {
            primary_window: {
              used_percent: 1,
              reset_at: 2_000_604_800,
              limit_window_seconds: 604_800,
            },
            secondary_window: {
              used_percent: 2,
              reset_at: 2_000_604_900,
              limit_window_seconds: 604_800,
            },
          },
        },
        1,
        "codex-a",
      ),
    ).toThrow(CodexUsageParseError);
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
    expect(snapshot.shortWindow?.usedPercent).toBe(100);
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
