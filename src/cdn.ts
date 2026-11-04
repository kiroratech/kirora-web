import * as sdk from './index.js';
import type { KiroraOptions } from './index.js';
import { asHeld, type HeldCall } from './tracking/page-context.js';

/** Methods the loader snippet doesn't queue, as they can't wait: see `replay()`. */
type Unqueued = 'requestPushPermission' | 'flush' | 'destroy';

/** What the loader snippet leaves on `window.kirora`: options and queued calls. */
type Snippet = [method: keyof sdk.Kirora, args: unknown[], held: HeldCall][] &
  Partial<Pick<sdk.Kirora, Unqueued>> & {
    options?: KiroraOptions;
    start?: HeldCall;
  };

/** The same exports as the npm package, plus `init()` for script-tag sites. */
const scriptTagGlobal = {
  ...sdk,
  init: (options: KiroraOptions) => new sdk.Kirora(options),
};

declare global {
  interface Window {
    Kirora: typeof scriptTagGlobal;
    kirora?: Snippet | sdk.Kirora;
  }
}

window.Kirora = scriptTagGlobal;

const snippet = window.kirora;
if (Array.isArray(snippet) && snippet.options) {
  const { options } = snippet;
  // Start the session and first page view from when the loader ran.
  const kirora = asHeld(snippet.start, () => new sdk.Kirora(options));
  // A permission prompt must happen during the click, so these go straight through.
  snippet.requestPushPermission = () => kirora.requestPushPermission();
  snippet.flush = () => kirora.flush();
  snippet.destroy = () => kirora.destroy();
  void replay(snippet, kirora);
}

/**
 * Makes the snippet's calls in order, each finished before the next, so a `track()` after
 * `identify()` or `logout()` belongs to whoever that left signed in. Calls the page makes
 * meanwhile still reach the snippet, so they wait their turn too. Then `window.kirora`
 * becomes the SDK.
 */
async function replay(calls: Snippet, kirora: sdk.Kirora): Promise<void> {
  // `calls.length` is read each time round, as the page may add more.
  for (let next = 0; next < calls.length; next++) {
    const [method, args, held] = calls[next]!;
    // Called with `.apply(kirora, …)` below.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const call = kirora[method] as (...args: unknown[]) => unknown;
    if (typeof call !== 'function') continue;
    try {
      // The held call's time and page are only needed while it's made, not awaited.
      await asHeld(held, () => call.apply(kirora, args));
    } catch (error) {
      console.error(`Kirora: ${method} failed`, error);
    }
  }
  window.kirora = kirora;
}
