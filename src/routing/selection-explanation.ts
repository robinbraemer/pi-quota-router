import type { SelectionDecision } from "../types.ts";

export function selectionSummary(decision: SelectionDecision): string {
  return decision.reason;
}
