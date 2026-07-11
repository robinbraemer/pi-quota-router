import { raceWithSignal } from "../util/abort.ts";

export interface AccountAffinityLease {
  beforeAttempt(accountId: string): void;
  release(): void;
}

export interface AccountAffinityCoordinator {
  acquire(sessionId: string | undefined, signal?: AbortSignal): Promise<AccountAffinityLease>;
  shutdown(): void;
}

interface SessionState {
  tail: Promise<void>;
  lastAttemptedAccountId?: string;
}

const NO_SESSION_LEASE: AccountAffinityLease = {
  beforeAttempt: () => undefined,
  release: () => undefined,
};

export function createAccountAffinityCoordinator(
  closeSession: (sessionId?: string) => void,
): AccountAffinityCoordinator {
  const states = new Map<string, SessionState>();
  const shutdownAbort = new AbortController();
  let shutDown = false;

  return {
    async acquire(sessionId, signal) {
      if (!sessionId) return NO_SESSION_LEASE;
      if (shutDown) throw new Error("Account affinity coordinator shut down");

      const state = states.get(sessionId) ?? { tail: Promise.resolve() };
      states.set(sessionId, state);
      const previous = state.tail;
      let openGate: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        openGate = resolve;
      });
      state.tail = previous.then(() => gate);
      const combined = signal
        ? AbortSignal.any([signal, shutdownAbort.signal])
        : shutdownAbort.signal;

      try {
        await raceWithSignal(previous, combined);
      } catch (error) {
        openGate();
        if (shutdownAbort.signal.aborted && !signal?.aborted) {
          throw new Error("Account affinity coordinator shut down");
        }
        throw error;
      }

      let released = false;
      return {
        beforeAttempt(accountId) {
          if (
            state.lastAttemptedAccountId !== undefined &&
            state.lastAttemptedAccountId !== accountId
          ) {
            // TODO(earendil-works/pi#6539): remove with the source-verified fixed Pi release.
            closeSession(sessionId);
          }
          state.lastAttemptedAccountId = accountId;
        },
        release() {
          if (released) return;
          released = true;
          openGate();
        },
      };
    },
    shutdown() {
      if (shutDown) return;
      shutDown = true;
      shutdownAbort.abort(new Error("Account affinity coordinator shut down"));
      for (const sessionId of states.keys()) closeSession(sessionId);
      states.clear();
    },
  };
}
