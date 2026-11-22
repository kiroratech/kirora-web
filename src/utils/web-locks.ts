/**
 * The browser's Web Locks, or undefined where there are none: before Firefox 96 and
 * Safari 15.4, and when server rendering.
 */
export function webLocks(): LockManager | undefined {
  return typeof navigator === 'undefined' ? undefined : navigator.locks;
}
