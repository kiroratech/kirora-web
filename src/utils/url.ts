/** `url` parsed, or undefined if it's missing or isn't one. */
export function urlOf(url: string | undefined, base?: URL): URL | undefined {
  try {
    return url ? new URL(url, base) : undefined;
  } catch {
    return undefined;
  }
}
