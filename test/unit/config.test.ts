import { describe, expect, test } from "bun:test";
import { defaultConfig, isPrimingAuthorized } from "../../src/config.ts";

describe("router config", () => {
  test("ships conservative routing defaults", () => {
    expect(defaultConfig.usageFreshnessMs).toBe(300_000);
    expect(defaultConfig.maxRotationAttempts).toBe(5);
    expect(defaultConfig.headroom.shortWindowMinimumPercent).toBe(10);
    expect(defaultConfig.headroom.weeklyMinimumPercent).toBe(3);
  });

  test("requires enablement and rolling-window confirmation", () => {
    expect(isPrimingAuthorized(defaultConfig)).toBe(false);
    expect(
      isPrimingAuthorized({
        ...defaultConfig,
        priming: {
          ...defaultConfig.priming,
          enabled: true,
          confirmedFirstUseRollingWindow: true,
        },
      }),
    ).toBe(true);
  });
});
