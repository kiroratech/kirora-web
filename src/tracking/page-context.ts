import { urlOf } from '../utils/url.js';

export const PAGE_VIEWED_EVENT = 'Page Viewed';

/** Campaign fields and their UTM tags. */
const CAMPAIGN_TAGS = {
  source: 'utm_source',
  medium: 'utm_medium',
  name: 'utm_campaign',
  term: 'utm_term',
  content: 'utm_content',
} as const;

type CampaignField = keyof typeof CAMPAIGN_TAGS;

/** The page part of an event's `context`. */
export type PageContext = {
  locale?: string;
  timezone?: string;
  page?: { url: string; path: string; title: string; referrer?: string };
  campaign?: Partial<Record<CampaignField, string>>;
};

/** When and where the loader snippet recorded a call, before the SDK loaded. */
export type HeldCall = { at: number; href: string; title: string; canonical?: string };

/** Doesn't change during the page's life, so we only look it up once. */
let localeAndTimezone: { locale: string; timezone: string } | undefined;
/** Only set while replaying a held call. */
let heldCall: HeldCall | undefined;

/** Replays a held call as of when it was made, since an SPA may have navigated since. */
export function asHeld<Result>(held: HeldCall | undefined, call: () => Result): Result {
  heldCall = held;
  try {
    return call();
  } finally {
    heldCall = undefined;
  }
}

/** Now, or the held call's time during a replay. */
export function eventTime(): Date {
  return new Date(heldCall?.at ?? Date.now());
}

/**
 * Page info for an event's `context`. Uses the canonical URL if the page has one. The
 * query string (apart from UTM tags) and hash are dropped, since they often hold tokens
 * or emails. The page's markup is the site's, so a malformed address in it is left out
 * (or the page's own used instead) rather than thrown.
 */
export function pageContext(): PageContext {
  if (typeof location === 'undefined' || typeof document === 'undefined') return {};
  localeAndTimezone ??= {
    locale: navigator.language,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
  const address = urlOf(heldCall?.href) ?? new URL(location.href);
  const canonical = heldCall
    ? heldCall.canonical
    : document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href;
  const page = urlOf(canonical, address) ?? address;
  const referrer = urlOf(document.referrer);
  const campaign = campaignTags(address);
  return {
    ...localeAndTimezone,
    page: {
      url: withoutQuery(page),
      path: page.pathname,
      title: heldCall?.title ?? document.title,
      ...(referrer ? { referrer: withoutQuery(referrer) } : {}),
    },
    ...(Object.keys(campaign).length > 0 ? { campaign } : {}),
  };
}

/** `Session Started` properties: landing path, referrer and UTM tags. */
export function sessionStartedProperties({
  page,
  campaign = {},
}: PageContext): Record<string, string> {
  return {
    ...(page ? { path: page.path } : {}),
    ...(page?.referrer ? { referrer: page.referrer } : {}),
    ...Object.fromEntries(
      Object.entries(campaign).map(([field, value]) => [
        CAMPAIGN_TAGS[field as CampaignField],
        value,
      ]),
    ),
  };
}

/** The address's UTM tags, the only part of its query string we keep. */
function campaignTags(address: URL): NonNullable<PageContext['campaign']> {
  const campaign: PageContext['campaign'] = {};
  for (const [field, tag] of Object.entries(CAMPAIGN_TAGS)) {
    const value = address.searchParams.get(tag);
    if (value) campaign[field as CampaignField] = value;
  }
  return campaign;
}

/** The query string and fragment often hold tokens or emails, so they're never sent. */
function withoutQuery(url: URL): string {
  return `${url.origin}${url.pathname}`;
}

/** How long a navigation waits for the new page's title before tracking without it. */
const TITLE_WAIT_MS = 1000;

/**
 * Runs `then` once the page has a title. Next.js and others empty it as they navigate and
 * set the new one a moment later.
 */
function whenTitled(then: () => void): void {
  const { head } = document;
  if (document.title || !head || typeof MutationObserver === 'undefined') return then();
  const done = () => {
    observer.disconnect();
    clearTimeout(timer);
    then();
  };
  const observer = new MutationObserver(() => {
    if (document.title) done();
  });
  observer.observe(head, { childList: true, subtree: true, characterData: true });
  const timer = setTimeout(done, TITLE_WAIT_MS);
}

/**
 * Calls `onPageView` now and on every path change, including SPA navigations through
 * `history`. Query-only changes don't count. Returns a function that stops watching.
 */
export function watchPageViews(onPageView: () => void): () => void {
  // During a replay the first page view is the held page's, and the app may have
  // navigated since without our patches in place yet.
  let lastPath = urlOf(heldCall?.href)?.pathname ?? location.pathname;
  let watching = true;
  // Deferred so the app has a chance to update the title first.
  const pathChanged = () =>
    setTimeout(() => {
      if (!watching || location.pathname === lastPath) return;
      const path = (lastPath = location.pathname);
      whenTitled(() => {
        // Not if the app has moved on since: that page gets its own view.
        if (watching && location.pathname === path) onPageView();
      });
    });
  // The patches stay once stopped, doing nothing more: something else may have patched
  // `history` over ours since, so putting the originals back could undo theirs.
  for (const method of ['pushState', 'replaceState'] as const) {
    const original = history[method].bind(history);
    history[method] = (...args: Parameters<History['pushState']>) => {
      original(...args);
      pathChanged();
    };
  }
  addEventListener('popstate', pathChanged);
  onPageView();
  pathChanged();
  return () => {
    watching = false;
    removeEventListener('popstate', pathChanged);
  };
}
