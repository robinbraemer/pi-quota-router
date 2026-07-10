import { setTimeout as delay } from "node:timers/promises";

export class ReservationLostError extends Error {
  override readonly name = "ReservationLostError";

  constructor() {
    super("The Codex account reservation could not be renewed");
  }
}

export function startReservationHeartbeat(options: {
  leaseToken: string;
  ttlMs: number;
  renew(leaseToken: string, ttlMs: number): Promise<boolean>;
  signal?: AbortSignal;
}): { signal: AbortSignal; stop(): Promise<void> } {
  const stopped = new AbortController();
  const failed = new AbortController();
  const heartbeatSignal = options.signal
    ? AbortSignal.any([options.signal, failed.signal])
    : failed.signal;
  const intervalMs = Math.max(1, Math.floor(options.ttlMs / 3));
  const running = (async () => {
    while (!stopped.signal.aborted) {
      try {
        await delay(intervalMs, undefined, { signal: stopped.signal });
      } catch (error) {
        if (stopped.signal.aborted) {
          return;
        }
        throw error;
      }
      if (!(await options.renew(options.leaseToken, options.ttlMs))) {
        throw new ReservationLostError();
      }
    }
  })().catch((error) => {
    failed.abort(error);
  });

  return {
    signal: heartbeatSignal,
    async stop() {
      stopped.abort();
      await running;
    },
  };
}
