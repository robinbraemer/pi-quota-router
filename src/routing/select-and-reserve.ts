import { randomUUID } from "node:crypto";
import type { AtomicJsonStore } from "../storage/atomic-json-store.ts";
import type { RuntimeStateFile } from "../storage/schemas.ts";
import type { Reservation, ReservationOwner, SelectionDecision } from "../types.ts";
import { type SelectionInput, selectAccount } from "./selection-policy.ts";

export interface ReservedSelection {
  decision: SelectionDecision;
  reservation?: Reservation;
  foregroundActiveBefore?: number;
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
      const primerLease = liveReservations.find(
        (value) => value.kind === "primer" && value.accountId === candidate.accountId,
      );
      const { block: _staleBlock, primerLease: _stalePrimerLease, ...current } = candidate;
      return {
        ...current,
        ...(block ? { block } : {}),
        ...(primerLease ? { primerLease } : {}),
      };
    });
    const selectableCandidates = candidates.filter(
      (candidate) =>
        !input.excludedAccountIds?.has(candidate.accountId) &&
        (!input.request.config.manualAccountId ||
          candidate.accountId === input.request.config.manualAccountId),
    );
    const decision = selectAccount({
      ...input.request,
      candidates: selectableCandidates,
      now: input.now,
    });
    if (!decision.accountId) {
      result = { decision };
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
    const foregroundActiveBefore = liveReservations.filter(
      (value) => value.kind === "foreground" && value.accountId === decision.accountId,
    ).length;
    result = { decision, reservation, foregroundActiveBefore };
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
