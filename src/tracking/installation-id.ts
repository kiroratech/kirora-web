import type { KeyValueStorage } from '../storage/device-storage.js';
import { uuid } from '../utils/uuid.js';

/**
 * `device.id`: a random id for this browser, made on first use and kept under `key`, per
 * workspace. Never a hardware or advertising id. It's also the browser's installation id
 * for push.
 */
export function installationId(storage: KeyValueStorage, key: string): string {
  const stored = storage.getItem(key);
  if (stored) return stored;
  const installationId = uuid();
  storage.setItem(key, installationId);
  return installationId;
}
