import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { z } from "zod";
import { defaultConfig } from "../../src/config.ts";
import { selectAndReserve } from "../../src/routing/select-and-reserve.ts";
import { createAtomicJsonStore } from "../../src/storage/atomic-json-store.ts";
import { resolveRouterPaths } from "../../src/storage/paths.ts";
import {
  AccountVaultFileSchema,
  defaultRuntimeState,
  RouterConfigSchema,
  type RuntimeStateFile,
  RuntimeStateFileSchema,
} from "../../src/storage/schemas.ts";
import { candidate } from "../fixtures/candidates.ts";
import { createStorageFixture } from "../fixtures/storage.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((cleanup) => cleanup())));

const frozenOldV1Config = {
  version: 1 as const,
  enabled: true,
  usageFreshnessMs: 300_000,
  maxRotationAttempts: 5,
  maxRecoveryWaitMs: 21_600_000,
  reservationTtlMs: 120_000,
  scoreHysteresisRatio: 0.1,
  headroom: { shortWindowMinimumPercent: 10, weeklyMinimumPercent: 3 },
  priming: {
    enabled: false,
    confirmedFirstUseRollingWindow: false,
    maximumPerSweep: 1,
    retryCooldownMs: 3_600_000,
  },
};
const frozenOldV1State = {
  version: 1 as const,
  usageSnapshots: [],
  blocks: [],
  reservations: [],
  priming: { confirmedAccountIds: [], retryAfter: {} },
  events: [],
};

const FrozenV1UsageWindowSchema = z
  .object({
    usedPercent: z.number().min(0).max(100),
    resetsAt: z.number().int().nonnegative().optional(),
  })
  .strict();
const FrozenV1ReservationSchema = z
  .object({
    accountId: z.string().min(1),
    leaseToken: z.string().min(1),
    owner: z
      .object({
        processId: z.number().int().nonnegative(),
        sessionId: z.string().min(1),
        requestId: z.string().min(1),
      })
      .strict(),
    createdAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
    kind: z.enum(["foreground", "primer"]),
  })
  .strict();
const FrozenV1RuntimeStateSchema = z
  .object({
    version: z.literal(1),
    usageSnapshots: z.array(
      z
        .object({
          accountId: z.string().min(1),
          observedAt: z.number().int().nonnegative(),
          shortWindow: FrozenV1UsageWindowSchema,
          weeklyWindow: FrozenV1UsageWindowSchema.optional(),
          stale: z.boolean(),
          planType: z.string().optional(),
          creditsRemaining: z.number().nonnegative().optional(),
        })
        .strict(),
    ),
    blocks: z.array(
      z
        .object({
          accountId: z.string().min(1),
          kind: z.enum(["quota", "auth", "transient"]),
          blockedAt: z.number().int().nonnegative(),
          retryAt: z.number().int().nonnegative().optional(),
          estimated: z.boolean(),
        })
        .strict(),
    ),
    reservations: z.array(FrozenV1ReservationSchema),
    priming: z
      .object({
        confirmedAccountIds: z.array(z.string()),
        retryAfter: z.record(z.string(), z.number().int().nonnegative()),
      })
      .strict(),
    lastSelection: z
      .object({
        accountId: z.string().optional(),
        reason: z.string(),
        candidates: z.array(
          z
            .object({
              accountId: z.string().min(1),
              eligible: z.boolean(),
              rejectionCode: z.string().optional(),
              weeklyRemainingPercent: z.number().optional(),
              shortWindowRemainingPercent: z.number().optional(),
              urgency: z.number().optional(),
              freshness: z.enum(["fresh", "stale", "unknown"]),
              selectedBecause: z.string().optional(),
            })
            .strict(),
        ),
      })
      .strict()
      .optional(),
    events: z.array(
      z
        .object({
          type: z.enum([
            "selection_started",
            "usage_refreshed",
            "candidate_rejected",
            "account_reserved",
            "account_selected",
            "primer_started",
            "primer_confirmed",
            "primer_inconclusive",
            "quota_blocked",
            "auth_refresh_started",
            "auth_refresh_succeeded",
            "auth_invalidated",
            "rotation_applied",
            "recovery_wait_started",
            "recovery_wait_ended",
            "request_completed",
          ]),
          at: z.number().int().nonnegative(),
          accountId: z.string().optional(),
          detail: z
            .record(z.string(), z.union([z.boolean(), z.number(), z.string(), z.null()]))
            .optional(),
        })
        .strict(),
    ),
  })
  .strict();

describe("router storage contracts", () => {
  test("resolves every file below the extension directory", () => {
    const base = join("/tmp", "pi-agent");
    expect(resolveRouterPaths(base)).toEqual({
      directory: join(base, "pi-quota-router"),
      accounts: join(base, "pi-quota-router", "accounts.json"),
      config: join(base, "pi-quota-router", "config.json"),
      state: join(base, "pi-quota-router", "state.json"),
      log: join(base, "pi-quota-router", "events.ndjson"),
    });
  });

  test("accepts valid version-one files", () => {
    expect(RouterConfigSchema.parse(defaultConfig)).toEqual(defaultConfig);
    expect(RuntimeStateFileSchema.parse(defaultRuntimeState)).toEqual(defaultRuntimeState);
    expect(RouterConfigSchema.parse(frozenOldV1Config)).toEqual(frozenOldV1Config);
    expect(RuntimeStateFileSchema.parse(frozenOldV1State)).toEqual(frozenOldV1State);
    expect(defaultConfig).toEqual(frozenOldV1Config);
    expect(defaultRuntimeState).toEqual(frozenOldV1State);
    expect(
      AccountVaultFileSchema.parse({
        version: 1,
        accounts: [
          {
            id: "codex-0123456789ab",
            label: "work",
            accountId: "account-1",
            accessToken: "access",
            refreshToken: "refresh",
            expiresAt: 10,
            createdAt: 1,
            updatedAt: 2,
          },
        ],
      }),
    ).toHaveProperty("accounts.0.label", "work");
  });

  test("rejects unknown persisted fields", () => {
    expect(() =>
      RouterConfigSchema.parse({
        ...defaultConfig,
        unsafeAutomaticPriming: true,
      }),
    ).toThrow();
  });

  test("keeps produced multi-foreground state readable by the frozen version-one schema", async () => {
    const fixture = await createStorageFixture();
    cleanups.push(fixture.cleanup);
    const store = createAtomicJsonStore<RuntimeStateFile>({
      path: fixture.file,
      schema: RuntimeStateFileSchema,
      createDefault: () => structuredClone(frozenOldV1State),
    });
    for (const requestId of ["one", "two"]) {
      await selectAndReserve({
        stateStore: store,
        request: {
          candidates: [candidate("a", 2_000_000_000_000)],
          config: frozenOldV1Config,
          now: 2_000_000_000_000,
        },
        owner: { processId: 1, sessionId: requestId, requestId },
        now: 2_000_000_000_000,
      });
    }
    const state = await store.read();

    expect(RuntimeStateFileSchema.parse(state).version).toBe(1);
    expect(FrozenV1RuntimeStateSchema.parse(state).reservations).toHaveLength(2);
    expect(state.reservations[0]?.accountId).toBe(state.reservations[1]?.accountId);
    expect(state.reservations.some((reservation) => reservation.kind === "foreground")).toBeTrue();
    const text = JSON.stringify(state);
    for (const runtimeOnly of [
      "foregroundActiveBefore",
      "primerLease",
      "lastSuccessfulAccountBySession",
      "concurrencyCap",
      "evidence",
    ]) {
      expect(text).not.toContain(runtimeOnly);
    }
  });

  test("preserves mixed-version primer safety while foreground semantics differ", async () => {
    const now = 2_000_000_000_000;
    const foreground = (leaseToken: string, expiresAt: number) => ({
      accountId: "a",
      leaseToken,
      owner: { processId: 1, sessionId: "old", requestId: "old" },
      createdAt: now,
      expiresAt,
      kind: "foreground" as const,
    });
    const accountPrimer = {
      ...foreground("account-primer", now + 60_000),
      kind: "primer" as const,
    };
    const multiForeground = FrozenV1RuntimeStateSchema.parse({
      ...frozenOldV1State,
      reservations: [
        foreground("foreground-one", now + 60_000),
        foreground("foreground-two", now + 60_000),
      ],
    });
    const liveFor = (reservations: typeof multiForeground.reservations, at: number) =>
      reservations.filter((reservation) => reservation.expiresAt > at);
    const oldForegroundEligible = (reservations: typeof multiForeground.reservations, at: number) =>
      !liveFor(reservations, at).some((reservation) => reservation.accountId === "a");
    const oldPrimerEligible = (reservations: typeof multiForeground.reservations, at: number) =>
      !liveFor(reservations, at).some((reservation) => reservation.accountId === "a");
    const selectWith = async (
      reservations: typeof multiForeground.reservations,
      at: number,
      requestId: string,
    ) => {
      const fixture = await createStorageFixture();
      cleanups.push(fixture.cleanup);
      const store = createAtomicJsonStore<RuntimeStateFile>({
        path: fixture.file,
        schema: RuntimeStateFileSchema,
        createDefault: () => structuredClone(frozenOldV1State),
      });
      await store.update((state) => ({ ...state, reservations }));
      return selectAndReserve({
        stateStore: store,
        request: { candidates: [candidate("a", at)], config: frozenOldV1Config, now: at },
        owner: { processId: 2, sessionId: "new", requestId },
        now: at,
      });
    };

    expect(oldForegroundEligible(multiForeground.reservations, now)).toBeFalse();
    expect(
      (await selectWith(multiForeground.reservations, now, "overlap")).reservation?.accountId,
    ).toBe("a");
    expect(oldPrimerEligible(multiForeground.reservations, now)).toBeFalse();
    expect(oldForegroundEligible(multiForeground.reservations, now + 60_001)).toBeTrue();
    expect(oldPrimerEligible(multiForeground.reservations, now + 60_001)).toBeTrue();

    const primerState = FrozenV1RuntimeStateSchema.parse({
      ...frozenOldV1State,
      reservations: [accountPrimer],
    });
    expect(oldForegroundEligible(primerState.reservations, now)).toBeFalse();
    const blocked = await selectWith(primerState.reservations, now, "primer-blocked");
    expect(blocked.reservation).toBeUndefined();
    expect(blocked.decision.candidates[0]?.rejectionCode).toBe("primer_active");
    expect(oldPrimerEligible(primerState.reservations, now)).toBeFalse();
    expect(
      (await selectWith(primerState.reservations, now + 60_001, "primer-expired")).reservation
        ?.accountId,
    ).toBe("a");
  });
});
