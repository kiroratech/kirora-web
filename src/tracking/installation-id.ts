import type { KeyValueStorage } from '../storage/device-storage.js';
import { base64UrlEncode } from '../utils/base64url.js';
import { uuid } from '../utils/uuid.js';

/**
 * `device.id`: a random id for this browser, made on first use and kept under `key`, per
 * workspace. Never a hardware or advertising id. It's also the browser's installation id
 * for push.
 */
export function installationId(storage: KeyValueStorage, key: string): string {
  const stored = storage.getItem(key);
  if (stored) {
    return stored;
  }
  const installationId = uuid();
  storage.setItem(key, installationId);
  return installationId;
}

/**
 * This browser's device secret, made on first use and kept under `key`: 32 random bytes,
 * base64url. Sent with each push registration, it lets the browser be detached with
 * nobody signed in. It lives as long as the device id, but on this device only, never in
 * the site's cookie, which would send it with every request to the site.
 */
export type DeviceSecret = {
  /** The secret, made now if there's none yet. */
  make(): string;
  /** The secret, if one was made. */
  read(): string | undefined;
  /** Forgets it, with the device id it goes with. */
  forget(): void;
};

export function deviceSecret(storage: KeyValueStorage, key: string): DeviceSecret {
  const read = () => storage.getItem(key) ?? undefined;
  return {
    read,
    make: () => {
      const stored = read();
      if (stored) {
        return stored;
      }
      const secret = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
      storage.setItem(key, secret);
      return secret;
    },
    forget: () => storage.removeItem(key),
  };
}
