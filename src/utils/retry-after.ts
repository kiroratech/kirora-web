/**
 * `Retry-After` as seconds or an HTTP date (RFC 9110), in milliseconds from now; undefined
 * if it's missing, malformed or already past. Shared by the page and the service worker.
 */
export function retryAfterMs(header: string | null): number | undefined {
  if (!header?.trim()) {
    return undefined;
  }
  const seconds = Number(header);
  const delayMs = Number.isNaN(seconds)
    ? Date.parse(header) - Date.now()
    : seconds * 1000;
  return delayMs > 0 ? delayMs : undefined;
}
