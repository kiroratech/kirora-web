/** `promise`, or a rejection once `ms` pass without an answer. */
export function withTimeout<Value>(promise: Promise<Value>, ms: number): Promise<Value> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`No answer after ${ms / 1000} seconds`)),
      ms,
    );
  });
  return Promise.race([promise, timedOut]).finally(() => clearTimeout(timeout));
}

/**
 * Waits for `promise` until `deadline` (epoch ms). True if it settled by then, resolved or
 * rejected; never rejects. The work itself carries on either way.
 */
export function settledBy(promise: Promise<unknown>, deadline: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now()));
    const settled = () => {
      clearTimeout(timeout);
      resolve(true);
    };
    promise.then(settled, settled);
  });
}
