export interface RouterConfig {
  version: 1;
  enabled: boolean;
  manualAccountId?: string | undefined;
  usageFreshnessMs: number;
  maxRotationAttempts: number;
  maxRecoveryWaitMs: number;
  reservationTtlMs: number;
  scoreHysteresisRatio: number;
  headroom: {
    shortWindowMinimumPercent: number;
    weeklyMinimumPercent: number;
  };
  priming: {
    enabled: boolean;
    confirmedFirstUseRollingWindow: boolean;
    maximumPerSweep: number;
    retryCooldownMs: number;
  };
}

export interface ManagedCodexAccount {
  id: string;
  label: string;
  accountId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
  needsReauth?: boolean;
}

export interface UsageWindow {
  usedPercent: number;
  resetsAt?: number | undefined;
}

export interface UsageSnapshot {
  accountId: string;
  observedAt: number;
  shortWindow: UsageWindow;
  weeklyWindow?: UsageWindow | undefined;
  stale: boolean;
  planType?: string | undefined;
  creditsRemaining?: number | undefined;
}

export interface AccountBlock {
  accountId: string;
  kind: "quota" | "auth" | "transient";
  blockedAt: number;
  retryAt?: number | undefined;
  estimated: boolean;
}

export interface ReservationOwner {
  processId: number;
  sessionId: string;
  requestId: string;
}

export interface Reservation {
  accountId: string;
  leaseToken: string;
  owner: ReservationOwner;
  createdAt: number;
  expiresAt: number;
  kind: "foreground" | "primer";
}

export interface Candidate {
  accountId: string;
  label: string;
  usage?: UsageSnapshot;
  needsReauth: boolean;
  block?: AccountBlock;
  reservation?: Reservation;
  untouched: boolean;
}

export interface CandidateExplanation {
  accountId: string;
  eligible: boolean;
  rejectionCode?: string;
  weeklyRemainingPercent?: number;
  shortWindowRemainingPercent?: number;
  urgency?: number;
  freshness: "fresh" | "stale" | "unknown";
  selectedBecause?: string;
}

export interface SelectionDecision {
  accountId?: string;
  reason: string;
  candidates: CandidateExplanation[];
}

export interface RoutingEvent {
  type:
    | "selection_started"
    | "usage_refreshed"
    | "candidate_rejected"
    | "account_reserved"
    | "account_selected"
    | "primer_started"
    | "primer_confirmed"
    | "primer_inconclusive"
    | "quota_blocked"
    | "auth_refresh_started"
    | "auth_refresh_succeeded"
    | "auth_invalidated"
    | "rotation_applied"
    | "recovery_wait_started"
    | "recovery_wait_ended"
    | "request_completed";
  at: number;
  accountId?: string;
  detail?: Record<string, boolean | number | string | null>;
}
