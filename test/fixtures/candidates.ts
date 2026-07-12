import type { Candidate, UsageSnapshot } from "../../src/types.ts";

const HOUR = 3_600_000;

export function usage(options: {
  accountId: string;
  now: number;
  shortRemaining?: number;
  weeklyRemaining?: number;
  resetHours?: number;
  stale?: boolean;
  ageMs?: number;
  weeklyWindow?: boolean;
  shortWindow?: boolean;
}): UsageSnapshot {
  const {
    accountId,
    now,
    shortRemaining = 80,
    weeklyRemaining = 50,
    resetHours = 24,
    stale = false,
    ageMs = 0,
    weeklyWindow = true,
    shortWindow = true,
  } = options;
  return {
    accountId,
    observedAt: now - ageMs,
    ...(shortWindow
      ? {
          shortWindow: {
            usedPercent: 100 - shortRemaining,
            resetsAt: now + 5 * HOUR,
          },
        }
      : {}),
    ...(weeklyWindow
      ? {
          weeklyWindow: {
            usedPercent: 100 - weeklyRemaining,
            resetsAt: now + resetHours * HOUR,
          },
        }
      : {}),
    stale,
  };
}

export function candidate(
  id: string,
  now: number,
  overrides: Partial<Candidate> & {
    shortRemaining?: number;
    weeklyRemaining?: number;
    resetHours?: number;
    stale?: boolean;
    ageMs?: number;
    weeklyWindow?: boolean;
    shortWindow?: boolean;
  } = {},
): Candidate {
  const {
    shortRemaining,
    weeklyRemaining,
    resetHours,
    stale,
    ageMs,
    weeklyWindow,
    shortWindow,
    ...candidateOverrides
  } = overrides;
  return {
    accountId: id,
    label: id,
    needsReauth: false,
    untouched: false,
    usage: usage({
      accountId: id,
      now,
      ...(shortRemaining !== undefined ? { shortRemaining } : {}),
      ...(weeklyRemaining !== undefined ? { weeklyRemaining } : {}),
      ...(resetHours !== undefined ? { resetHours } : {}),
      ...(stale !== undefined ? { stale } : {}),
      ...(ageMs !== undefined ? { ageMs } : {}),
      ...(weeklyWindow !== undefined ? { weeklyWindow } : {}),
      ...(shortWindow !== undefined ? { shortWindow } : {}),
    }),
    ...candidateOverrides,
  };
}
