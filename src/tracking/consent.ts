import type { DeviceStorage } from '../storage/device-storage.js';
import { STORAGE_KEYS } from '../storage/keys.js';
import type { Log } from '../utils/log.js';

type Answer = 'granted' | 'refused';

/**
 * Tracking consent. With `requireTrackingConsent`, nothing is tracked until the visitor
 * says yes; without it, until they say no. The answer is remembered on the device, per
 * workspace.
 *
 * If storage can't be read, a refusal may be stored there unseen, so tracking waits for
 * an answer given to this client, which holds until the page closes.
 */
export class TrackingConsent {
  private readonly key: string;
  /** The answer given to this client, for when storage can't be read. */
  private given: Answer | null = null;

  constructor(
    private readonly storage: DeviceStorage,
    namespace: string,
    private readonly required: boolean,
    private readonly log: Log,
  ) {
    this.key = STORAGE_KEYS.trackingConsent(namespace);
  }

  get allowed(): boolean {
    const answer = this.current();
    if (answer === null && !this.storage.readable) return false;
    return this.required ? answer === 'granted' : answer !== 'refused';
  }

  /** The visitor said no, as opposed to not having answered yet. */
  get refused(): boolean {
    return this.current() === 'refused';
  }

  /** Records the visitor's answer. True if tracking has just become allowed. */
  answer(granted: boolean): boolean {
    const newlyAllowed = granted && !this.allowed;
    const answer: Answer = granted ? 'granted' : 'refused';
    // Takes effect at once, whether or not it can be saved.
    this.given = answer;
    this.storage.setItem(this.key, answer);
    if (!this.storage.persistent) {
      this.log(
        'error',
        "Can't save the tracking choice on this device: it holds until the page closes, " +
          'so ask again on the next visit',
      );
    }
    return newlyAllowed;
  }

  private current(): Answer | null {
    if (!this.storage.readable) return this.given;
    const stored = this.storage.getItem(this.key);
    // Reading may have just failed.
    if (!this.storage.readable) return this.given;
    return stored === 'granted' || stored === 'refused' ? stored : null;
  }
}
