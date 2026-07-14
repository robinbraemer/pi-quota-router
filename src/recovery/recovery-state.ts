import type { AccountBlock, UsageSnapshot } from "../types.ts";
import type { FailureClass } from "./failure-classifier.ts";

const DEFAULT_QUOTA_COOLDOWN_MS = 3_600_000;
const MAX_COOLDOWN_MS = 21_600_000;

export function blockFromFailure(
  accountId: string,
  failure: FailureClass,
  usage: UsageSnapshot | undefined,
  now: number,
): AccountBlock {
  if (failure.kind === "auth-invalid") {
    return { accountId, kind: "auth", blockedAt: now, estimated: false };
  }
  if (failure.kind === "auth-retry") {
    return {
      accountId,
      kind: "auth",
      blockedAt: now,
      retryAt: now + 60_000,
      estimated: true,
    };
  }
  if (failure.kind === "transient") {
    return {
      accountId,
      kind: "transient",
      blockedAt: now,
      retryAt: Math.min(failure.retryAt, now + MAX_COOLDOWN_MS),
      estimated: true,
    };
  }

  const observedReset = latestExhaustedReset(usage, now);
  const explicitReset = failure.kind === "quota" ? failure.retryAt : undefined;
  const retryAt = explicitReset ?? observedReset ?? now + DEFAULT_QUOTA_COOLDOWN_MS;
  return {
    accountId,
    kind: failure.kind === "quota" ? "quota" : "transient",
    blockedAt: now,
    retryAt: Math.min(retryAt, now + MAX_COOLDOWN_MS),
    estimated: explicitReset === undefined && observedReset === undefined,
  };
}

export function reconcileUsageBlock(
  block: AccountBlock,
  usage: UsageSnapshot,
  now: number,
): AccountBlock | undefined {
  if (block.kind !== "quota" || !block.estimated || block.retryAt === undefined) {
    return block;
  }
  const observedReset = latestExhaustedReset(usage, now);
  if (observedReset === undefined) {
    return undefined;
  }
  return {
    ...block,
    retryAt: Math.min(observedReset, now + MAX_COOLDOWN_MS),
    estimated: false,
  };
}

export function blockFromUsage(
  accountId: string,
  usage: UsageSnapshot,
  now: number,
): AccountBlock | undefined {
  const retryAt = earliestExhaustedReset(usage, now);
  if (retryAt === undefined) {
    return undefined;
  }
  return {
    accountId,
    kind: "quota",
    blockedAt: now,
    retryAt,
    estimated: false,
  };
}

function earliestExhaustedReset(usage: UsageSnapshot | undefined, now: number): number | undefined {
  const resets = exhaustedResets(usage, now);
  return resets.length > 0 ? Math.min(...resets) : undefined;
}

function latestExhaustedReset(usage: UsageSnapshot | undefined, now: number): number | undefined {
  const resets = exhaustedResets(usage, now);
  return resets.length > 0 ? Math.max(...resets) : undefined;
}

function exhaustedResets(usage: UsageSnapshot | undefined, now: number): number[] {
  if (!usage) {
    return [];
  }
  const windows = [usage.shortWindow, usage.weeklyWindow];
  const resets = windows
    .filter(
      (window) =>
        window !== undefined &&
        window.usedPercent >= 100 &&
        window.resetsAt !== undefined &&
        window.resetsAt > now,
    )
    .map((window) => window?.resetsAt)
    .filter((reset): reset is number => reset !== undefined);
  return resets;
}
