import type { RouterConfig } from "./types.ts";

export const defaultConfig: RouterConfig = {
  version: 1,
  enabled: true,
  usageFreshnessMs: 300_000,
  maxRotationAttempts: 5,
  maxRecoveryWaitMs: 21_600_000,
  reservationTtlMs: 120_000,
  scoreHysteresisRatio: 0.1,
  headroom: {
    shortWindowMinimumPercent: 10,
    weeklyMinimumPercent: 3,
  },
  priming: {
    enabled: false,
    confirmedFirstUseRollingWindow: false,
    maximumPerSweep: 1,
    retryCooldownMs: 3_600_000,
  },
};

export function isPrimingAuthorized(config: RouterConfig): boolean {
  return config.priming.enabled && config.priming.confirmedFirstUseRollingWindow;
}
