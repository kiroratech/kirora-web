import type { NotificationClickListener } from '../types.js';
import type { Log } from '../utils/log.js';

/** Taps kept for listeners that attach later: the latest ten, as on Android. */
const MAX_HELD = 10;
/** Taps already heard, by id: the worker may hand the same one over twice. */
const MAX_SEEN = 20;

/**
 * Taps on Kirora pushes, as the service worker hands them to this page: a tap whose link
 * opened this page, or that brought this tab forward. Each reaches every listener once,
 * after its report; one that arrives before any listener is held for the first.
 */
export class NotificationTaps {
  private readonly listeners = new Set<NotificationClickListener>();
  private held: Record<string, string>[] = [];
  /** Asks the worker for a tap held for this page, once something listens for it. */
  private askForHeld: (() => void) | undefined;
  private readonly seen: string[] = [];

  constructor(private readonly log: Log) {}

  /**
   * Listens to the service worker at `serviceWorkerUrl`, from now on, whenever
   * permission is granted. If `askForHeld`, asks it for a tap held for this page, which
   * opened before the SDK could listen, once the app adds a listener: a page whose app
   * never listens doesn't wake the worker for it. Returns a function that stops.
   */
  watch(serviceWorkerUrl: string, askForHeld: boolean): () => void {
    const container = navigator.serviceWorker;
    const onMessage = (event: MessageEvent) => this.receive(event.data);
    // Messages wait in the browser until the document has loaded. Not started early with
    // startMessages(): that would start them for the site's own listeners too, before
    // the site has attached them.
    container.addEventListener('message', onMessage);
    if (askForHeld) {
      this.askForHeld = () =>
        void container
          .getRegistration(serviceWorkerUrl)
          .then((registration) =>
            registration?.active?.postMessage({ kirora: 'listening' }),
          )
          .catch(() => undefined);
    }
    return () => {
      this.askForHeld = undefined;
      container.removeEventListener('message', onMessage);
    };
  }

  add(listener: NotificationClickListener): void {
    this.askForHeld?.();
    this.askForHeld = undefined;
    this.listeners.add(listener);
    const held = this.held;
    this.held = [];
    for (const data of held) {
      this.call(listener, data);
    }
  }

  remove(listener: NotificationClickListener): void {
    this.listeners.delete(listener);
  }

  private receive(message: unknown): void {
    const tap = message as { kirora?: unknown; id?: unknown; data?: unknown } | null;
    if (tap?.kirora !== 'notificationClick' || typeof tap.id !== 'string') {
      return;
    }
    if (this.seen.includes(tap.id)) {
      return;
    }
    this.seen.push(tap.id);
    if (this.seen.length > MAX_SEEN) {
      this.seen.shift();
    }
    const data = stringsOf(tap.data);
    if (this.listeners.size === 0) {
      this.held.push(data);
      if (this.held.length > MAX_HELD) {
        this.held.shift();
      }
      return;
    }
    for (const listener of this.listeners) {
      this.call(listener, data);
    }
  }

  /** Each listener gets its own copy, and its errors are logged, never thrown. */
  private call(listener: NotificationClickListener, data: Record<string, string>): void {
    try {
      listener({ ...data });
    } catch (error) {
      this.log('error', 'Error in notification click listener', error);
    }
  }
}

/** The push's `data`, keeping only string values, as Kirora sends them. */
function stringsOf(data: unknown): Record<string, string> {
  const strings: Record<string, string> = {};
  if (typeof data !== 'object' || data === null) {
    return strings;
  }
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === 'string') {
      strings[key] = value;
    }
  }
  return strings;
}
