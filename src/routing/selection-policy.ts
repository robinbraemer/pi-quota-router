import type {
  Candidate,
  CandidateExplanation,
  RouterConfig,
  SelectionDecision,
  UsageSnapshot,
} from "../types.ts";

const MAX_STALE_MS = 86_400_000;
const STALE_PENALTY_PERCENT = 5;

export interface SelectionInput {
  candidates: Candidate[];
  config: RouterConfig;
  now: number;
  currentAccountId?: string;
}

interface RankedCandidate {
  candidate: Candidate;
  explanation: CandidateExplanation;
  weeklyRemaining: number;
  shortRemaining: number;
  urgency: number;
  freshness: "fresh" | "stale";
}

export function weeklyUrgency(snapshot: UsageSnapshot, now: number): number {
  const weekly = snapshot.weeklyWindow;
  if (!weekly?.resetsAt) {
    return 0;
  }
  const remaining = Math.max(0, 1 - weekly.usedPercent / 100);
  const hours = Math.max(0.25, (weekly.resetsAt - now) / 3_600_000);
  return remaining / hours;
}

export function selectAccount(input: SelectionInput): SelectionDecision {
  if (!input.config.enabled) {
    return {
      reason: "routing_disabled",
      candidates: input.candidates.map((candidate) =>
        reject(candidate, "unknown", "routing_disabled"),
      ),
    };
  }

  if (input.config.manualAccountId) {
    return selectManual(input, input.config.manualAccountId);
  }

  const evaluated = input.candidates.map((candidate) => evaluate(candidate, input));
  const explanations = evaluated.map((value) => value.explanation);
  const eligible = evaluated.filter(
    (value): value is { explanation: CandidateExplanation; ranked: RankedCandidate } =>
      value.ranked !== undefined,
  );
  if (eligible.length === 0) {
    return { reason: "no_eligible_accounts", candidates: explanations };
  }

  const fresh = eligible.filter((value) => value.ranked.freshness === "fresh");
  const tier = fresh.length > 0 ? fresh : eligible;
  const topUrgency = Math.max(...tier.map((value) => value.ranked.urgency));
  const threshold = topUrgency * (1 - input.config.scoreHysteresisRatio);

  if (input.currentAccountId) {
    const current = tier.find(
      (value) =>
        value.ranked.candidate.accountId === input.currentAccountId &&
        value.ranked.urgency >= threshold,
    );
    if (current) {
      current.explanation.selectedBecause = "current_account_hysteresis";
      return {
        accountId: current.ranked.candidate.accountId,
        reason: "current_account_hysteresis",
        candidates: explanations,
      };
    }
  }

  const tied = tier
    .filter((value) => value.ranked.urgency >= threshold)
    .sort((left, right) => {
      if (left.ranked.weeklyRemaining !== right.ranked.weeklyRemaining) {
        return left.ranked.weeklyRemaining - right.ranked.weeklyRemaining;
      }
      if (left.ranked.shortRemaining !== right.ranked.shortRemaining) {
        return right.ranked.shortRemaining - left.ranked.shortRemaining;
      }
      return left.ranked.candidate.accountId.localeCompare(right.ranked.candidate.accountId);
    });
  const selected = tied[0];
  if (!selected) {
    return { reason: "no_eligible_accounts", candidates: explanations };
  }
  selected.explanation.selectedBecause =
    tied.length === 1 ? "highest_weekly_urgency" : "urgency_tie_break";
  return {
    accountId: selected.ranked.candidate.accountId,
    reason: selected.explanation.selectedBecause,
    candidates: explanations,
  };
}

function selectManual(input: SelectionInput, accountId: string): SelectionDecision {
  const explanations = input.candidates.map((candidate) => {
    const rejectionCode = baseHealthRejection(candidate, input.now);
    return rejectionCode
      ? reject(candidate, usageFreshness(candidate, input), rejectionCode)
      : eligibleExplanation(candidate, usageFreshness(candidate, input));
  });
  const index = input.candidates.findIndex((candidate) => candidate.accountId === accountId);
  const selected = input.candidates[index];
  const explanation = explanations[index];
  if (!selected || !explanation?.eligible) {
    return { reason: "manual_account_unavailable", candidates: explanations };
  }
  explanation.selectedBecause = "manual_override";
  return { accountId, reason: "manual_override", candidates: explanations };
}

function evaluate(
  candidate: Candidate,
  input: SelectionInput,
): { explanation: CandidateExplanation; ranked?: RankedCandidate } {
  const freshness = usageFreshness(candidate, input);
  const baseRejection = baseHealthRejection(candidate, input.now);
  if (baseRejection) {
    return { explanation: reject(candidate, freshness, baseRejection) };
  }
  if (!candidate.usage) {
    return { explanation: reject(candidate, "unknown", "usage_unknown") };
  }
  if (freshness === "unknown") {
    return { explanation: reject(candidate, "unknown", "usage_unknown") };
  }
  const age = Math.max(0, input.now - candidate.usage.observedAt);
  if (age > MAX_STALE_MS) {
    return { explanation: reject(candidate, "stale", "usage_too_old") };
  }
  if (candidate.untouched) {
    return { explanation: reject(candidate, freshness, "untouched_unprimed") };
  }
  const weekly = candidate.usage.weeklyWindow;
  if (!weekly?.resetsAt) {
    return { explanation: reject(candidate, freshness, "weekly_window_unknown") };
  }

  const penalty = freshness === "stale" ? STALE_PENALTY_PERCENT : 0;
  const shortRemaining = Math.max(0, 100 - candidate.usage.shortWindow.usedPercent - penalty);
  const weeklyRemaining = Math.max(0, 100 - weekly.usedPercent - penalty);
  if (shortRemaining < input.config.headroom.shortWindowMinimumPercent) {
    return {
      explanation: reject(candidate, freshness, "short_headroom", {
        shortWindowRemainingPercent: shortRemaining,
        weeklyRemainingPercent: weeklyRemaining,
      }),
    };
  }
  if (weeklyRemaining < input.config.headroom.weeklyMinimumPercent) {
    return {
      explanation: reject(candidate, freshness, "weekly_headroom", {
        shortWindowRemainingPercent: shortRemaining,
        weeklyRemainingPercent: weeklyRemaining,
      }),
    };
  }

  const hours = Math.max(0.25, (weekly.resetsAt - input.now) / 3_600_000);
  const urgency = weeklyRemaining / 100 / hours;
  const explanation: CandidateExplanation = {
    accountId: candidate.accountId,
    eligible: true,
    weeklyRemainingPercent: weeklyRemaining,
    shortWindowRemainingPercent: shortRemaining,
    urgency,
    freshness,
  };
  return {
    explanation,
    ranked: {
      candidate,
      explanation,
      weeklyRemaining,
      shortRemaining,
      urgency,
      freshness,
    },
  };
}

function baseHealthRejection(candidate: Candidate, now: number): string | undefined {
  if (candidate.needsReauth) {
    return "needs_reauth";
  }
  if (candidate.block && (candidate.block.retryAt === undefined || candidate.block.retryAt > now)) {
    return "blocked";
  }
  if (candidate.reservation && candidate.reservation.expiresAt > now) {
    return "reserved";
  }
  return undefined;
}

function usageFreshness(
  candidate: Candidate,
  input: Pick<SelectionInput, "config" | "now">,
): "fresh" | "stale" | "unknown" {
  if (!candidate.usage) {
    return "unknown";
  }
  return candidate.usage.stale ||
    input.now - candidate.usage.observedAt >= input.config.usageFreshnessMs
    ? "stale"
    : "fresh";
}

function eligibleExplanation(
  candidate: Candidate,
  freshness: CandidateExplanation["freshness"],
): CandidateExplanation {
  return { accountId: candidate.accountId, eligible: true, freshness };
}

function reject(
  candidate: Candidate,
  freshness: CandidateExplanation["freshness"],
  rejectionCode: string,
  values: Partial<CandidateExplanation> = {},
): CandidateExplanation {
  return {
    accountId: candidate.accountId,
    eligible: false,
    freshness,
    rejectionCode,
    ...values,
  };
}
