import type { KeyValueStorage } from './device-storage.js';

/** One year, though Safari may cap it. */
const SITE_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;
/** A shared value that was removed. No stored value is empty. */
const REMOVED = '';

/**
 * Storage shared across subdomains, using a cookie on the site's root domain. Values are
 * copied to `device` too, in case cookies are blocked. Removing a value leaves the cookie
 * empty rather than deleting it, so a subdomain that still has its own copy drops it
 * instead of sharing it again.
 */
export function siteStorage(device: KeyValueStorage): KeyValueStorage {
  if (typeof document === 'undefined') return device;
  // Worked out on first write, so no cookie is set before consent.
  let domain: { value: string | undefined } | undefined;
  const write = (key: string, value: string) => {
    try {
      domain ??= { value: siteDomain() };
      document.cookie = [
        `${cookieName(key)}=${encodeURIComponent(value)}`,
        'path=/',
        `max-age=${SITE_COOKIE_MAX_AGE_SECONDS}`,
        'SameSite=Lax',
        ...(domain.value ? [`domain=${domain.value}`] : []),
        ...(location.protocol === 'https:' ? ['Secure'] : []),
      ].join('; ');
    } catch {
      // Cookies are off limits (e.g. a sandboxed iframe): the device's copy is all we have.
    }
  };
  return {
    getItem: (key) => {
      const shared = readCookie(cookieName(key));
      // Removed on another subdomain, e.g. as consent was withdrawn there.
      if (shared === REMOVED) {
        device.removeItem(key);
        return null;
      }
      if (shared !== null) return shared;
      // The cookie is missing (blocked or cleared): copy the device's value over.
      const own = device.getItem(key);
      if (own !== null) write(key, own);
      return own;
    },
    setItem: (key, value) => {
      write(key, value);
      device.setItem(key, value);
    },
    removeItem: (key) => {
      // Only if it was ever stored, so no cookie is set before consent. The cookie may
      // be gone (Safari expires them) while another subdomain still has a copy.
      const shared = readCookie(cookieName(key));
      if (shared !== REMOVED && (shared !== null || device.getItem(key) !== null)) {
        write(key, REMOVED);
      }
      device.removeItem(key);
    },
  };
}

/** `kirora:session` -> `kirora_session`. */
function cookieName(key: string): string {
  return key.replace(/\W/g, '_');
}

/** Null if it's missing, or cookies can't be read (a sandboxed iframe throws). */
function readCookie(name: string): string | null {
  let cookies: string;
  try {
    cookies = document.cookie;
  } catch {
    return null;
  }
  for (const pair of cookies.split('; ')) {
    const separator = pair.indexOf('=');
    if (pair.slice(0, separator) !== name) continue;
    try {
      return decodeURIComponent(pair.slice(separator + 1));
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * The root domain, e.g. `example.com` for `app.example.com`, found by trying a test cookie
 * on each suffix until the browser accepts one. Undefined on `localhost`.
 */
function siteDomain(): string | undefined {
  const labels = location.hostname.split('.');
  for (let index = labels.length - 2; index >= 0; index--) {
    const candidate = labels.slice(index).join('.');
    const probe = `kirora_probe=1; path=/; domain=${candidate}`;
    document.cookie = probe;
    if (readCookie('kirora_probe') === '1') {
      document.cookie = `${probe}; max-age=0`;
      return candidate;
    }
  }
  return undefined;
}
