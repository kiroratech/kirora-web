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
