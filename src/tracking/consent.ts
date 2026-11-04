import type { KeyValueStorage } from '../storage/device-storage.js';
import { STORAGE_KEYS } from '../storage/keys.js';

/**
 * Tracking consent. With `requireTrackingConsent`, nothing is tracked until the visitor
 * says yes; without it, until they say no. The answer is remembered on the device.
 */
export class TrackingConsent {
  constructor(
    private readonly storage: KeyValueStorage,
    private readonly required: boolean,
  ) {}

  get allowed(): boolean {
    const answer = this.storedAnswer();
    return this.required ? answer === 'granted' : answer !== 'refused';
  }

  /** The visitor said no, as opposed to not having answered yet. */
  get refused(): boolean {
    return this.storedAnswer() === 'refused';
  }

  private storedAnswer(): string | null {
    return this.storage.getItem(STORAGE_KEYS.trackingConsent);
  }

  /** Records the visitor's answer. True if tracking has just become allowed. */
  answer(granted: boolean): boolean {
    const newlyAllowed = granted && !this.allowed;
    this.storage.setItem(STORAGE_KEYS.trackingConsent, granted ? 'granted' : 'refused');
    return newlyAllowed;
  }
}
