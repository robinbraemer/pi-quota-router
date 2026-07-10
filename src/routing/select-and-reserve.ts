import { randomUUID } from "node:crypto";
import type { AtomicJsonStore } from "../storage/atomic-json-store.ts";
import type { RuntimeStateFile } from "../storage/schemas.ts";
import type { Reservation, ReservationOwner, SelectionDecision } from "../types.ts";
import { type SelectionInput, selectAccount } from "./selection-policy.ts";

export interface ReservedSelection {
  decision: SelectionDecision;
  recoverableAccountIds: string[];
  reservation?: Reservation;
}

export async function selectAndReserve(input: {
  stateStore: AtomicJsonStore<RuntimeStateFile>;
  request: SelectionInput;
  excludedAccountIds?: ReadonlySet<string>;
  owner: ReservationOwner;
  now: number;
}): Promise<ReservedSelection> {
  let result: ReservedSelection | undefined;

  await input.stateStore.update((state) => {
    const liveReservations = state.reservations.filter(
      (reservation) => reservation.expiresAt > input.now,
    );
    const candidates = input.request.candidates.map((candidate) => {
      const block = state.blocks.find((value) => value.accountId === candidate.accountId);
      const reservation = liveReservations.find((value) => value.accountId === candidate.accountId);
      const { block: _staleBlock, reservation: _staleReservation, ...current } = candidate;
      return {
        ...current,
        ...(block ? { block } : {}),
        ...(reservation ? { reservation } : {}),
      };
    });
    const selectableCandidates = candidates.filter(
      (candidate) => !input.excludedAccountIds?.has(candidate.accountId),
    );
    const recoveryCandidates = input.request.config.manualAccountId
      ? candidates.filter(
          (candidate) => candidate.accountId === input.request.config.manualAccountId,
        )
      : candidates;
    const recoveryDecision = selectAccount({
      ...input.request,
      candidates: recoveryCandidates,
      now: input.now,
    });
    const decision = input.excludedAccountIds?.size
      ? selectAccount({
          ...input.request,
          candidates: selectableCandidates,
          now: input.now,
        })
      : recoveryDecision;
    const recoverableAccountIds = recoveryDecision.candidates
      .filter((explanation) => {
        const candidate = recoveryCandidates.find(
          (value) => value.accountId === explanation.accountId,
        );
        return (
          (explanation.eligible && input.excludedAccountIds?.has(explanation.accountId)) ||
          (explanation.rejectionCode === "blocked" &&
            candidate?.block?.retryAt !== undefined &&
            candidate.block.retryAt > input.now) ||
          (explanation.rejectionCode === "reserved" &&
            candidate?.reservation !== undefined &&
            candidate.reservation.expiresAt > input.now)
        );
      })
      .map((candidate) => candidate.accountId);
    if (!decision.accountId) {
      result = { decision, recoverableAccountIds };
      return { ...state, reservations: liveReservations, lastSelection: decision };
    }

    const reservation: Reservation = {
      accountId: decision.accountId,
      leaseToken: randomUUID(),
      owner: input.owner,
      createdAt: input.now,
      expiresAt: input.now + input.request.config.reservationTtlMs,
      kind: "foreground",
    };
    result = { decision, recoverableAccountIds, reservation };
    return {
      ...state,
      reservations: [...liveReservations, reservation],
      lastSelection: decision,
    };
  });

  if (!result) {
    throw new Error("Atomic selection did not produce a result");
  }
  return result;
}
