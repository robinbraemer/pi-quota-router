export function nextStreamEvent<T>(
  iterator: AsyncIterator<T>,
  signal: AbortSignal,
): Promise<IteratorResult<T>> {
  if (signal.aborted) {
    void iterator.return?.().catch(() => undefined);
    return Promise.reject(signal.reason);
  }
  return new Promise<IteratorResult<T>>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const onAbort = () => {
      void iterator.return?.().catch(() => undefined);
      finish(() => reject(signal.reason));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void iterator.next().then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}
