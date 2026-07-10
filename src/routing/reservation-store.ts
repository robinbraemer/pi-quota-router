import { randomUUID } from "node:crypto";
import type { AtomicJsonStore } from "../storage/atomic-json-store.ts";
import type { RuntimeStateFile } from "../storage/schemas.ts";
import type { Reservation, ReservationOwner } from "../types.ts";

const PRIMER_SWEEP_ACCOUNT = "__primer_sweep__";

export interface ReservationStore {
  release(leaseToken: string): Promise<boolean>;
  renew(leaseToken: string, now: number, ttlMs: number): Promise<boolean>;
  cleanupExpired(now: number): Promise<number>;
  acquirePrimerSweep(
    owner: ReservationOwner,
    now: number,
    ttlMs: number,
  ): Promise<Reservation | undefined>;
}

export function createReservationStore(store: AtomicJsonStore<RuntimeStateFile>): ReservationStore {
  return {
    async release(leaseToken) {
      let released = false;
      await store.update((state) => {
        const reservations = state.reservations.filter((reservation) => {
          if (reservation.leaseToken === leaseToken) {
            released = true;
            return false;
          }
          return true;
        });
        return { ...state, reservations };
      });
      return released;
    },

    async renew(leaseToken, now, ttlMs) {
      let renewed = false;
      await store.update((state) => ({
        ...state,
        reservations: state.reservations
          .filter((reservation) => reservation.expiresAt > now)
          .map((reservation) => {
            if (reservation.leaseToken !== leaseToken) {
              return reservation;
            }
            renewed = true;
            return { ...reservation, expiresAt: now + ttlMs };
          }),
      }));
      return renewed;
    },

    async cleanupExpired(now) {
      let removed = 0;
      await store.update((state) => {
        const reservations = state.reservations.filter((reservation) => {
          const live = reservation.expiresAt > now;
          if (!live) {
            removed += 1;
          }
          return live;
        });
        return { ...state, reservations };
      });
      return removed;
    },

    async acquirePrimerSweep(owner, now, ttlMs) {
      let acquired: Reservation | undefined;
      await store.update((state) => {
        const reservations = state.reservations.filter(
          (reservation) => reservation.expiresAt > now,
        );
        if (
          reservations.some(
            (reservation) =>
              reservation.kind === "primer" && reservation.accountId === PRIMER_SWEEP_ACCOUNT,
          )
        ) {
          return { ...state, reservations };
        }
        acquired = {
          accountId: PRIMER_SWEEP_ACCOUNT,
          leaseToken: randomUUID(),
          owner,
          createdAt: now,
          expiresAt: now + ttlMs,
          kind: "primer",
        };
        return { ...state, reservations: [...reservations, acquired] };
      });
      return acquired;
    },
  };
}
