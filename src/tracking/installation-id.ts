import type { KeyValueStorage } from '../storage/device-storage.js';
import { STORAGE_KEYS } from '../storage/keys.js';
import { uuid } from '../utils/uuid.js';

/**
 * `device.id`: a random id for this browser, made on first use. Never a hardware or
 * advertising id. It's also the browser's installation id for push.
 */
export function installationId(storage: KeyValueStorage): string {
  const stored = storage.getItem(STORAGE_KEYS.installationId);
  if (stored) return stored;
  const installationId = uuid();
  storage.setItem(STORAGE_KEYS.installationId, installationId);
  return installationId;
}

export function removeInstallationId(storage: KeyValueStorage): void {
  storage.removeItem(STORAGE_KEYS.installationId);
}
