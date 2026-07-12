import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../../src/config.ts";
import { selectAccount, weeklyUrgency } from "../../src/routing/selection-policy.ts";
import type { Reservation } from "../../src/types.ts";
import { candidate, usage } from "../fixtures/candidates.ts";

const NOW = 2_000_000_000_000;

describe("quota-aware selection", () => {
  test("spends high remaining quota near reset before distant quota", () => {
    const decision = selectAccount({
      candidates: [
        candidate("near", NOW, { weeklyRemaining: 80, resetHours: 1 }),
        candidate("distant", NOW, { weeklyRemaining: 20, resetHours: 100 }),
      ],
      config: defaultConfig,
      now: NOW,
    });
    expect(decision.accountId).toBe("near");
  });

  test("drains the least weekly remaining account when urgency is tied", () => {
    const decision = selectAccount({
      candidates: [
        candidate("thirty", NOW, { weeklyRemaining: 30, resetHours: 30 }),
        candidate("ten", NOW, { weeklyRemaining: 10, resetHours: 10 }),
      ],
      config: defaultConfig,
      now: NOW,
    });
    expect(decision.accountId).toBe("ten");
  });

  test("short-window and weekly headroom veto an urgency winner", () => {
    const decision = selectAccount({
      candidates: [
        candidate("short-low", NOW, {
          shortRemaining: 9,
          weeklyRemaining: 90,
          resetHours: 1,
        }),
        candidate("weekly-low", NOW, {
          weeklyRemaining: 2,
          resetHours: 1,
        }),
        candidate("safe", NOW, { weeklyRemaining: 20, resetHours: 20 }),
      ],
      config: defaultConfig,
      now: NOW,
    });
    expect(decision.accountId).toBe("safe");
    expect(decision.candidates.find((value) => value.accountId === "short-low")).toEqual(
      expect.objectContaining({ rejectionCode: "short_headroom" }),
    );
  });

  test("routes a weekly-only account without inventing short headroom", () => {
    const decision = selectAccount({
      candidates: [
        candidate("weekly-only", NOW, {
          shortWindow: false,
          weeklyRemaining: 97,
          resetHours: 168,
        }),
      ],
      config: defaultConfig,
      now: NOW,
    });

    expect(decision.accountId).toBe("weekly-only");
    expect(decision.candidates[0]).toEqual(
      expect.objectContaining({
        eligible: true,
        weeklyRemainingPercent: 97,
      }),
    );
    expect(decision.candidates[0]?.shortWindowRemainingPercent).toBeUndefined();
  });

  test("uses fresh candidates before penalized stale fallback data", () => {
    const decision = selectAccount({
      candidates: [
        candidate("stale", NOW, {
          weeklyRemaining: 90,
          resetHours: 1,
          stale: true,
          ageMs: 600_000,
        }),
        candidate("fresh", NOW, { weeklyRemaining: 10, resetHours: 100 }),
      ],
      config: defaultConfig,
      now: NOW,
    });
    expect(decision.accountId).toBe("fresh");
  });

  test("excludes missing, over-age, and untouched quota clocks", () => {
    const decision = selectAccount({
      candidates: [
        candidate("missing-weekly", NOW, { weeklyWindow: false }),
        candidate("too-old", NOW, { stale: true, ageMs: 86_400_001 }),
        candidate("untouched", NOW, {
          untouched: true,
          weeklyRemaining: 100,
          resetHours: 1,
        }),
      ],
      config: defaultConfig,
      now: NOW,
    });
    expect(decision.accountId).toBeUndefined();
    expect(decision.reason).toBe("no_eligible_accounts");
  });

  test("excludes a snapshot after its weekly reset clock elapses", () => {
    const decision = selectAccount({
      candidates: [
        candidate("expired", NOW, { weeklyRemaining: 90, resetHours: -1 }),
        candidate("valid", NOW, { weeklyRemaining: 20, resetHours: 20 }),
      ],
      config: defaultConfig,
      now: NOW,
    });

    expect(decision.accountId).toBe("valid");
    expect(decision.candidates.find((value) => value.accountId === "expired")).toEqual(
      expect.objectContaining({ rejectionCode: "weekly_reset_elapsed" }),
    );
  });

  test("honors a healthy manual account and reports an unhealthy override", () => {
    const forced = candidate("forced", NOW, {
      shortRemaining: 1,
      weeklyRemaining: 1,
      untouched: true,
    });
    expect(
      selectAccount({
        candidates: [forced, candidate("auto", NOW)],
        config: { ...defaultConfig, manualAccountId: "forced" },
        now: NOW,
      }).accountId,
    ).toBe("forced");

    const unhealthy = selectAccount({
      candidates: [{ ...forced, needsReauth: true }, candidate("auto", NOW)],
      config: { ...defaultConfig, manualAccountId: "forced" },
      now: NOW,
    });
    expect(unhealthy.accountId).toBeUndefined();
    expect(unhealthy.reason).toBe("manual_account_unavailable");
  });

  test("rejects a live primer lease in automatic and manual routing", () => {
    const primerLease: Reservation = {
      accountId: "forced",
      leaseToken: "synthetic-primer-lease",
      owner: {
        processId: 7,
        sessionId: "other-session",
        requestId: "other-request",
      },
      createdAt: NOW,
      expiresAt: NOW + 60_000,
      kind: "primer",
    };
    const automatic = selectAccount({
      candidates: [{ ...candidate("forced", NOW), primerLease }, candidate("healthy", NOW)],
      config: defaultConfig,
      now: NOW,
    });
    expect(automatic.accountId).toBe("healthy");
    expect(automatic.candidates[0]?.rejectionCode).toBe("primer_active");

    const manual = selectAccount({
      candidates: [{ ...candidate("forced", NOW), primerLease }],
      config: { ...defaultConfig, manualAccountId: "forced" },
      now: NOW,
    });
    expect(manual.reason).toBe("manual_account_unavailable");
    expect(manual.candidates[0]?.rejectionCode).toBe("primer_active");
  });

  test("ignores an expired primer lease", () => {
    const expiredPrimer: Reservation = {
      accountId: "expired-primer",
      leaseToken: "synthetic-expired-primer",
      owner: { processId: 7, sessionId: "session", requestId: "request" },
      createdAt: NOW - 120_000,
      expiresAt: NOW - 1,
      kind: "primer",
    };
    const decision = selectAccount({
      candidates: [{ ...candidate("expired-primer", NOW), primerLease: expiredPrimer }],
      config: defaultConfig,
      now: NOW,
    });
    expect(decision.accountId).toBe("expired-primer");
  });

  test("reports reauthentication and blocks before primer activity", () => {
    const primerLease: Reservation = {
      accountId: "a",
      leaseToken: "synthetic-primer-ordering",
      owner: { processId: 7, sessionId: "session", requestId: "request" },
      createdAt: NOW,
      expiresAt: NOW + 60_000,
      kind: "primer",
    };
    const decision = selectAccount({
      candidates: [
        { ...candidate("reauth", NOW), needsReauth: true, primerLease },
        {
          ...candidate("blocked", NOW),
          block: {
            accountId: "blocked",
            kind: "quota",
            blockedAt: NOW,
            retryAt: NOW + 1,
            estimated: false,
          },
          primerLease,
        },
      ],
      config: defaultConfig,
      now: NOW,
    });
    expect(decision.candidates.map((value) => value.rejectionCode)).toEqual([
      "needs_reauth",
      "blocked",
    ]);
  });

  test("retains the current account inside the ten-percent hysteresis band", () => {
    const decision = selectAccount({
      candidates: [
        candidate("current", NOW, { weeklyRemaining: 19, resetHours: 20 }),
        candidate("winner", NOW, { weeklyRemaining: 20, resetHours: 20 }),
      ],
      config: defaultConfig,
      currentAccountId: "current",
      now: NOW,
    });
    expect(decision.accountId).toBe("current");
  });

  test("uses short headroom then stable id for complete ties", () => {
    const decision = selectAccount({
      candidates: [
        candidate("b", NOW, { shortRemaining: 70 }),
        candidate("a", NOW, { shortRemaining: 80 }),
      ],
      config: defaultConfig,
      now: NOW,
    });
    expect(decision.accountId).toBe("a");

    const lexical = selectAccount({
      candidates: [candidate("b", NOW), candidate("a", NOW)],
      config: defaultConfig,
      now: NOW,
    });
    expect(lexical.accountId).toBe("a");
  });

  test("computes weekly remaining per hour", () => {
    expect(
      weeklyUrgency(
        usage({
          accountId: "a",
          now: NOW,
          weeklyRemaining: 50,
          resetHours: 2,
        }),
        NOW,
      ),
    ).toBeCloseTo(0.25);
  });

  test("does not assign urgency to an elapsed weekly reset", () => {
    expect(
      weeklyUrgency(
        usage({
          accountId: "a",
          now: NOW,
          weeklyRemaining: 50,
          resetHours: -1,
        }),
        NOW,
      ),
    ).toBe(0);
  });
});
