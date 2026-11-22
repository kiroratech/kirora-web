import type { DeviceStorage } from '../storage/device-storage.js';
import { STORAGE_KEYS } from '../storage/keys.js';
import type { Log } from '../utils/log.js';

type Answer = 'granted' | 'refused';

/**
 * Tracking consent. With `requireTrackingConsent`, nothing is tracked until the visitor
 * says yes; without it, until they say no. The answer is remembered on the device, per
 * workspace, and a refusal twice: in the answer's own key and in a copy under another, so
 * a value lost or garbled in one can't lose it. Either copy saying no counts.
 *
 * If the answer can't be understood, it's as if the visitor hadn't answered, unless the
 * copy holds a refusal; but with `requireTrackingConsent` a grant is never assumed.
 * If storage can't be read at all, neither copy can be seen, so only an answer given to
 * this client counts, holding until the page closes, and until then nothing is tracked.
 * If it can be read but no longer written, a stored refusal still counts, but a stored
 * grant may be out of date and is ignored: tracking needs a fresh one.
 */
export class TrackingConsent {
  private readonly key: string;
  private readonly refusalKey: string;
  /** The answer given to this client, for when storage can't be trusted. */
  private given: Answer | null = null;
  private toldUnreadable = false;

  constructor(
    private readonly storage: DeviceStorage,
    namespace: string,
    private readonly required: boolean,
    private readonly log: Log,
  ) {
    this.key = STORAGE_KEYS.trackingConsent(namespace);
    this.refusalKey = STORAGE_KEYS.trackingRefused(namespace);
  }

  get allowed(): boolean {
    const answer = this.current();
    if (answer === 'unknown') {
      return false;
    }
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
    const grantSaved = !granted && this.storage.getItem(this.key) === 'granted';
    // The copy first, as every SDK does.
    if (granted) {
      this.storage.removeItem(this.refusalKey);
    } else {
      this.storage.setItem(this.refusalKey, answer);
    }
    this.storage.setItem(this.key, answer);
    if (grantSaved && !this.storage.persistent) {
      // The refusal only reached memory, so the grant saved before would come back on
      // the next page. Removing may work where writing didn't (a full quota).
      this.storage.removeItem(this.key);
      this.storage.setItem(this.key, answer);
    }
    if (!this.storage.persistent) {
      this.log(
        'error',
        "Can't save the tracking choice on this device: it holds until the page closes, " +
          'so ask again on the next visit',
      );
    }
    return newlyAllowed;
  }

  /**
   * The answer as far as it can be told: `null` if there's none, `unknown` if it can't
   * be read and isn't safe to assume.
   */
  private current(): Answer | null | 'unknown' {
    if (!this.storage.readable) {
      return this.given ?? 'unknown';
    }
    const stored = this.storage.getItem(this.key);
    const copy = this.storage.getItem(this.refusalKey);
    // Reading may have just failed.
    if (!this.storage.readable) {
      return this.given ?? 'unknown';
    }
    if (stored === 'refused' || copy === 'refused') {
      return 'refused';
    }
    if (stored === 'granted') {
      // Once writes fail, only a grant given to this client counts: one saved before may
      // be out of date. Ignored, not deleted, since reading changes nothing.
      return this.storage.persistent || this.given !== null ? 'granted' : null;
    }
    if (stored === null) {
      return null;
    }
    // Garbled, and the copy holds no refusal: a fresh start, but never an assumed grant.
    if (!this.toldUnreadable) {
      this.toldUnreadable = true;
      this.log('error', "Can't read the saved tracking choice: treated as unanswered");
    }
    return this.required ? 'unknown' : null;
  }
}
