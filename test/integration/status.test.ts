import { describe, expect, test } from "bun:test";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { createStatusController, formatCompactStatus } from "../../src/status/status-controller.ts";

const NOW = 2_000_000_000_000;

describe("quota router status", () => {
  test("formats remaining quota and reset countdown consistently", () => {
    expect(
      formatCompactStatus({
        label: "work",
        snapshot: {
          accountId: "a",
          observedAt: NOW,
          shortWindow: { usedPercent: 28 },
          weeklyWindow: { usedPercent: 59, resetsAt: NOW + 18 * 3_600_000 },
          stale: false,
        },
        urgency: 0.023,
        mode: "auto",
        now: NOW,
      }),
    ).toBe("Codex · work · 5h 72% · 7d 41%/18h · urgent 0.023/h · auto");
  });

  test("renders only cached state through Pi setStatus", () => {
    const values: Array<string | undefined> = [];
    let reads = 0;
    const controller = createStatusController({
      readCached: () => {
        reads += 1;
        return { label: "none", mode: "login" };
      },
      clock: () => NOW,
    });
    const ui = {
      setStatus: (_key: string, value: string | undefined) => values.push(value),
    } as unknown as ExtensionUIContext;
    controller.render(ui);
    expect(reads).toBe(1);
    expect(values).toEqual(["Codex · none · login"]);
  });
});
