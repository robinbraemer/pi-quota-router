import { setTimeout as delay } from "node:timers/promises";

export class ReservationLostError extends Error {
  override readonly name = "ReservationLostError";

  constructor(cause?: unknown) {
    super(
      "The Codex account reservation could not be renewed",
      cause === undefined ? undefined : { cause },
    );
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
      let renewed: boolean;
      try {
        renewed = await options.renew(options.leaseToken, options.ttlMs);
      } catch (error) {
        throw new ReservationLostError(error);
      }
      if (!renewed) {
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
