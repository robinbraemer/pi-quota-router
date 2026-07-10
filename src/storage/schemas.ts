import { z } from "zod";

const ManagedCodexAccountSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1).max(80),
    accountId: z.string().min(1),
    accessToken: z.string().min(1),
    refreshToken: z.string().min(1),
    expiresAt: z.number().int().nonnegative(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    needsReauth: z.boolean().optional(),
  })
  .strict();

export const AccountVaultFileSchema = z
  .object({
    version: z.literal(1),
    accounts: z.array(ManagedCodexAccountSchema),
  })
  .strict();

const UsageWindowSchema = z
  .object({
    usedPercent: z.number().min(0).max(100),
    resetsAt: z.number().int().nonnegative().optional(),
  })
  .strict();

const UsageSnapshotSchema = z
  .object({
    accountId: z.string().min(1),
    observedAt: z.number().int().nonnegative(),
    shortWindow: UsageWindowSchema,
    weeklyWindow: UsageWindowSchema,
    stale: z.boolean(),
    planType: z.string().optional(),
    creditsRemaining: z.number().nonnegative().optional(),
  })
  .strict();

const AccountBlockSchema = z
  .object({
    accountId: z.string().min(1),
    kind: z.enum(["quota", "auth", "transient"]),
    blockedAt: z.number().int().nonnegative(),
    retryAt: z.number().int().nonnegative().optional(),
    estimated: z.boolean(),
  })
  .strict();

const ReservationSchema = z
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

const CandidateExplanationSchema = z
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
  .strict();

const SelectionDecisionSchema = z
  .object({
    accountId: z.string().optional(),
    reason: z.string(),
    candidates: z.array(CandidateExplanationSchema),
  })
  .strict();

const RoutingEventSchema = z
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
  .strict();

export const RouterConfigSchema = z
  .object({
    version: z.literal(1),
    enabled: z.boolean(),
    manualAccountId: z.string().min(1).optional(),
    usageFreshnessMs: z.number().int().positive(),
    maxRotationAttempts: z.number().int().positive(),
    maxRecoveryWaitMs: z.number().int().nonnegative(),
    reservationTtlMs: z.number().int().positive(),
    scoreHysteresisRatio: z.number().min(0).max(1),
    headroom: z
      .object({
        shortWindowMinimumPercent: z.number().min(0).max(100),
        weeklyMinimumPercent: z.number().min(0).max(100),
      })
      .strict(),
    priming: z
      .object({
        enabled: z.boolean(),
        confirmedFirstUseRollingWindow: z.boolean(),
        maximumPerSweep: z.number().int().positive(),
        retryCooldownMs: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();

export const RuntimeStateFileSchema = z
  .object({
    version: z.literal(1),
    usageSnapshots: z.array(UsageSnapshotSchema),
    blocks: z.array(AccountBlockSchema),
    reservations: z.array(ReservationSchema),
    priming: z
      .object({
        confirmedAccountIds: z.array(z.string()),
        retryAfter: z.record(z.string(), z.number().int().nonnegative()),
      })
      .strict(),
    lastSelection: SelectionDecisionSchema.optional(),
    events: z.array(RoutingEventSchema),
  })
  .strict();

export type AccountVaultFile = z.infer<typeof AccountVaultFileSchema>;
export type RuntimeStateFile = z.infer<typeof RuntimeStateFileSchema>;

export const defaultRuntimeState: RuntimeStateFile = {
  version: 1,
  usageSnapshots: [],
  blocks: [],
  reservations: [],
  priming: {
    confirmedAccountIds: [],
    retryAfter: {},
  },
  events: [],
};
