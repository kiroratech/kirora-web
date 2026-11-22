/** setTimeout's longest delay; a longer wait sets a timer this long and checks again. */
export const MAX_TIMER_MS = 2 ** 31 - 1;

/** Resolves once `ms` have passed. */
export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
 * Whether `promise` settles by `deadline` (epoch ms). It isn't cancelled otherwise: it
 * carries on by itself, and its outcome is nobody's concern.
 */
export async function settledBy(
  promise: Promise<unknown>,
  deadline: number,
): Promise<boolean> {
  try {
    await withTimeout(
      promise.catch(() => undefined),
      deadline - Date.now(),
    );
    return true;
  } catch {
    return false;
  }
}
