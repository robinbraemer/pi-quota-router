import { describe, expect, test } from "bun:test";
import {
  blockFromFailure,
  blockFromUsage,
  reconcileUsageBlock,
} from "../../src/recovery/recovery-state.ts";
import type { UsageSnapshot } from "../../src/types.ts";

const NOW = 2_000_000_000_000;

function exhausted(shortReset?: number, weeklyReset?: number): UsageSnapshot {
  return {
    accountId: "a",
    observedAt: NOW,
    shortWindow: {
      usedPercent: 100,
      ...(shortReset ? { resetsAt: shortReset } : {}),
    },
    weeklyWindow: {
      usedPercent: 100,
      ...(weeklyReset ? { resetsAt: weeklyReset } : {}),
    },
    stale: false,
  };
}

describe("recovery state", () => {
  test("blocks quota until every exhausted active window resets", () => {
    const block = blockFromFailure(
      "a",
      { kind: "quota" },
      exhausted(NOW + 3_600_000, NOW + 7_200_000),
      NOW,
    );
    expect(block).toEqual(expect.objectContaining({ retryAt: NOW + 7_200_000, estimated: false }));
  });

  test("uses a one-hour estimate when no reset is reliable", () => {
    const block = blockFromFailure("a", { kind: "quota" }, undefined, NOW);
    expect(block).toEqual(expect.objectContaining({ retryAt: NOW + 3_600_000, estimated: true }));
  });

  test("derives a quota block from an exhausted weekly-only window", () => {
    expect(
      blockFromUsage(
        "a",
        {
          accountId: "a",
          observedAt: NOW,
          weeklyWindow: { usedPercent: 100, resetsAt: NOW + 604_800_000 },
          stale: false,
        },
        NOW,
      ),
    ).toEqual({
      accountId: "a",
      kind: "quota",
      blockedAt: NOW,
      retryAt: NOW + 604_800_000,
      estimated: false,
    });
  });

  test("fresh authoritative usage replaces an estimated cooldown", () => {
    const block = blockFromFailure("a", { kind: "quota" }, undefined, NOW);
    const shorter = reconcileUsageBlock(block, exhausted(NOW + 1_800_000, NOW + 7_200_000), NOW);
    expect(shorter?.retryAt).toBe(NOW + 7_200_000);
    const longer = reconcileUsageBlock(
      { ...block, retryAt: NOW + 900_000 },
      exhausted(NOW + 7_200_000, NOW + 10_800_000),
      NOW,
    );
    expect(longer?.retryAt).toBe(NOW + 10_800_000);
  });

  test("fresh available usage clears an explicit quota cooldown", () => {
    const block = {
      accountId: "a",
      kind: "quota" as const,
      blockedAt: NOW - 1,
      retryAt: NOW + 3_600_000,
      estimated: false,
    };
    const usage: UsageSnapshot = {
      accountId: "a",
      observedAt: NOW,
      weeklyWindow: { usedPercent: 21, resetsAt: NOW + 604_800_000 },
      stale: false,
    };

    expect(reconcileUsageBlock(block, usage, NOW)).toBeUndefined();
  });

  test("fresh usage preserves estimated transient and auth cooldowns", () => {
    const usage = exhausted();
    const transient = blockFromFailure(
      "a",
      { kind: "transient", retryAt: NOW + 60_000 },
      undefined,
      NOW,
    );
    const auth = blockFromFailure("a", { kind: "auth-retry" }, undefined, NOW);

    expect(reconcileUsageBlock(transient, usage, NOW)).toEqual(transient);
    expect(reconcileUsageBlock(auth, usage, NOW)).toEqual(auth);
  });
});
