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

/** The page an event happened on, as Segment's analytics.js describes it. */
export type Page = {
  url: string;
  path: string;
  search: string;
  title: string;
  referrer?: string;
};

/** The page address's UTM tags. */
export type Campaign = Partial<Record<CampaignField, string>>;

/** The page part of an event's `context`. */
export type PageContext = {
  locale?: string;
  timezone?: string;
  page?: Page;
  campaign?: Campaign;
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
 * Page info for an event's `context`, collected as Segment's analytics.js collects it.
 * Kirora cuts values longer than it keeps, so none are cut here. The page's markup is the
 * site's, so a malformed address in it is left out (or the page's
 * own used instead) rather than thrown.
 */
export function pageContext(): PageContext {
  if (typeof location === 'undefined' || typeof document === 'undefined') return {};
  localeAndTimezone ??= {
    locale: navigator.language,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };

  // During a replay, the page is the one the loader saw when the call was made.
  const address = urlOf(heldCall?.href) ?? new URL(location.href);
  const canonicalHref = heldCall
    ? heldCall.canonical
    : document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href;
  const canonical = urlOf(canonicalHref, address);
  const referrer = urlOf(document.referrer);
  const title = heldCall?.title ?? document.title;

  const page: Page = {
    url: pageUrl(address, canonical),
    path: (canonical ?? address).pathname,
    search: address.search,
    title,
  };
  if (referrer) page.referrer = withoutFragment(referrer);

  const context: PageContext = { ...localeAndTimezone, page };
  const campaign = campaignTags(address);
  if (Object.keys(campaign).length > 0) context.campaign = campaign;
  return context;
}

/**
 * The page's URL, as Segment gives it: the canonical URL if the page has one, with the
 * page's own query string added unless the canonical URL has one; otherwise the address
 * the browser shows. Never the fragment.
 */
function pageUrl(address: URL, canonical: URL | undefined): string {
  if (!canonical) return withoutFragment(address);
  const url = new URL(canonical.href);
  if (!url.search) url.search = address.search;
  return withoutFragment(url);
}

function withoutFragment(url: URL): string {
  const { href } = url;
  const fragmentStart = href.indexOf('#');
  return fragmentStart === -1 ? href : href.slice(0, fragmentStart);
}

/** `Session Started` properties: landing path, referrer and UTM tags. */
export function sessionStartedProperties({
  page,
  campaign = {},
}: PageContext): Record<string, string> {
  const properties: Record<string, string> = {};
  if (page) properties.path = page.path;
  if (page?.referrer) properties.referrer = page.referrer;
  for (const [field, value] of Object.entries(campaign)) {
    properties[CAMPAIGN_TAGS[field as CampaignField]] = value;
  }
  return properties;
}

/** The address's UTM tags, as campaign fields. */
function campaignTags(address: URL): Campaign {
  const campaign: Campaign = {};
  for (const [field, tag] of Object.entries(CAMPAIGN_TAGS)) {
    const value = address.searchParams.get(tag);
    if (value) campaign[field as CampaignField] = value;
  }
  return campaign;
}

/**
 * How long a navigation waits for the new page's title. Many apps keep one title for every
 * page, so an unchanged title only gets a moment to change. An empty one (Next.js empties
 * it while it navigates) is waited for longer.
 */
const UNCHANGED_TITLE_WAIT_MS = 100;
const EMPTY_TITLE_WAIT_MS = 1000;

/**
 * Calls `onReady` once the page's title has changed from `previousTitle`, the title it had
 * when the app navigated, or once waiting longer isn't worth it (see above).
 */
function waitForNewTitle(previousTitle: string, onReady: () => void): void {
  const hasNewTitle = () => document.title !== '' && document.title !== previousTitle;
  if (hasNewTitle() || !document.head) {
    onReady();
    return;
  }

  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    observer.disconnect();
    clearTimeout(unchangedTimeout);
    clearTimeout(emptyTimeout);
    onReady();
  };
  const observer = new MutationObserver(() => {
    if (hasNewTitle()) finish();
  });
  const unchangedTimeout = setTimeout(() => {
    if (document.title !== '') finish();
  }, UNCHANGED_TITLE_WAIT_MS);
  const emptyTimeout = setTimeout(finish, EMPTY_TITLE_WAIT_MS);
  // The title lives in <head>, and frameworks change it by replacing or editing <title>.
  observer.observe(document.head, {
    childList: true,
    subtree: true,
    characterData: true,
  });
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
  const onNavigation = () => {
    // Noted now: by the time the app has rendered the new page, its title will have changed.
    const previousTitle = document.title;
    // Deferred, so a navigation that changes the path more than once counts once.
    setTimeout(() => {
      if (!watching || location.pathname === lastPath) return;
      const newPath = location.pathname;
      lastPath = newPath;
      waitForNewTitle(previousTitle, () => {
        // Not if the app has moved on meanwhile: that page gets its own view.
        if (watching && location.pathname === newPath) onPageView();
      });
    });
  };
  // The patches stay once stopped, doing nothing more: something else may have patched
  // `history` over ours since, so putting the originals back could undo theirs.
  for (const method of ['pushState', 'replaceState'] as const) {
    const original = history[method].bind(history);
    history[method] = (...args: Parameters<History['pushState']>) => {
      original(...args);
      onNavigation();
    };
  }
  addEventListener('popstate', onNavigation);
  onPageView();
  // In a replay, catches a page the app moved to after the held one, before we loaded.
  onNavigation();
  return () => {
    watching = false;
    removeEventListener('popstate', onNavigation);
  };
}
