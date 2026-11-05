import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Kirora } from '../src/index.js';
import {
  asHeld,
  eventTime,
  pageContext,
  watchPageViews,
} from '../src/tracking/page-context.js';
import { recordEvents } from './fake-kirora.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

type PageSetup = {
  href: string;
  title?: string;
  referrer?: string;
  /** The page's canonical link, if it has one. */
  canonical?: string;
  /** Replaces the page's `querySelector`, e.g. to make reading the markup fail. */
  querySelector?: () => unknown;
};

/**
 * A browser page at `href`, with everything the SDK reads: `location`, `document`,
 * `history` and a `MutationObserver`. `setTitle` changes the title as an app would,
 * telling the observers.
 */
function stubPage({
  href,
  title = 'Pricing',
  referrer = '',
  canonical,
  querySelector = () => (canonical ? { href: canonical } : null),
}: PageSetup) {
  const page = {
    title,
    referrer,
    cookie: '',
    visibilityState: 'visible',
    head: {},
    querySelector,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  const observers = new Set<() => void>();
  vi.stubGlobal('location', new URL(href));
  vi.stubGlobal('document', page);
  vi.stubGlobal('history', { pushState: () => undefined, replaceState: () => undefined });
  vi.stubGlobal('addEventListener', () => undefined);
  vi.stubGlobal('removeEventListener', () => undefined);
  vi.stubGlobal(
    'MutationObserver',
    class {
      constructor(private readonly notify: () => void) {}
      observe() {
        observers.add(this.notify);
      }
      disconnect() {
        observers.delete(this.notify);
      }
    },
  );
  return {
    page,
    setTitle: (newTitle: string) => {
      page.title = newTitle;
      for (const notify of [...observers]) notify();
    },
  };
}

describe('page context', () => {
  it('names the page by its canonical address with the real query, as Segment does', () => {
    stubPage({
      href: 'https://example.com/pricing-b?utm_source=newsletter&plan=pro#faq',
      canonical: 'https://example.com/pricing',
    });

    expect(pageContext()).toMatchObject({
      page: {
        url: 'https://example.com/pricing?utm_source=newsletter&plan=pro',
        path: '/pricing',
        search: '?utm_source=newsletter&plan=pro',
        title: 'Pricing',
      },
      campaign: { source: 'newsletter' },
    });
  });

  it("keeps a canonical address's own query, and sends the full referrer", () => {
    stubPage({
      href: 'https://example.com/pricing-b?plan=pro',
      canonical: 'https://example.com/pricing?v=2',
      referrer: 'https://news.example/?story=9#top',
    });

    expect(pageContext().page).toEqual({
      url: 'https://example.com/pricing?v=2',
      path: '/pricing',
      search: '?plan=pro',
      title: 'Pricing',
      referrer: 'https://news.example/?story=9',
    });
  });

  it("uses the page's own address when its canonical one is malformed", () => {
    stubPage({
      href: 'https://example.com/pricing?utm_source=newsletter',
      canonical: 'http://[',
      referrer: 'not a url',
    });

    expect(pageContext().page).toEqual({
      url: 'https://example.com/pricing?utm_source=newsletter',
      path: '/pricing',
      search: '?utm_source=newsletter',
      title: 'Pricing',
    });
  });

  it('makes a held call as of when and where the loader saw it', () => {
    stubPage({ href: 'https://example.com/checkout' });
    const held = {
      at: Date.UTC(2026, 9, 17),
      href: 'https://example.com/pricing',
      title: 'Plans',
    };

    const [context, time] = asHeld(held, () => [pageContext(), eventTime()] as const);

    expect(context.page).toMatchObject({ path: '/pricing', title: 'Plans' });
    expect(time.toISOString()).toBe('2026-10-17T00:00:00.000Z');
    // Only while the held call is made.
    expect(pageContext().page?.path).toBe('/checkout');
  });
});

describe('the client on a page', () => {
  it('still tracks the page when its canonical address is malformed', async () => {
    stubPage({ href: 'https://example.com/pricing', canonical: 'http://[' });
    const sent = recordEvents();
    const kirora = new Kirora({ clientKey: 'kirora_pk_test', trackPageViews: true });

    kirora.track('Plan Compared');
    await kirora.identify('token-for-ada');
    await kirora.flush();
    kirora.destroy();

    expect(sent.map((event) => [event.name, event.context.page?.url])).toEqual([
      ['Session Started', 'https://example.com/pricing'],
      ['Page Viewed', 'https://example.com/pricing'],
      ['Plan Compared', 'https://example.com/pricing'],
    ]);
  });

  it("never throws into the page when reading the page's markup fails", () => {
    stubPage({
      href: 'https://example.com/pricing',
      querySelector: () => {
        throw new Error('broken markup');
      },
    });
    recordEvents();
    let kirora: Kirora | undefined;

    expect(() => {
      kirora = new Kirora({
        clientKey: 'kirora_pk_test',
        trackPageViews: true,
        logLevel: 'none',
      });
      kirora.track('Plan Compared');
      kirora.trackPageView();
    }).not.toThrow();
    kirora?.destroy();
  });
});

/**
 * A single-page app at `/`, titled `Home`, whose new title comes a moment after it
 * navigates. Next.js empties the title first (`emptying`); others leave the old one.
 */
function navigatingApp({ emptying }: { emptying: boolean }) {
  const { page, setTitle } = stubPage({ href: 'https://example.com/', title: 'Home' });
  return {
    navigate(path: string) {
      vi.stubGlobal('location', new URL(path, 'https://example.com'));
      if (emptying) page.title = '';
      history.pushState(null, '', path);
    },
    setTitle,
  };
}

/** Watches page views, collecting each as `path title`. */
function watchViews() {
  const viewed: string[] = [];
  const stop = watchPageViews(() => {
    const { path, title } = pageContext().page!;
    viewed.push(`${path} ${title}`);
  });
  return { viewed, stop };
}

describe('page views', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('tracks the page the app moved to before the SDK loaded, after the held one', async () => {
    stubPage({ href: 'https://example.com/b' });
    const viewed: string[] = [];
    const held = { at: Date.now(), href: 'https://example.com/a', title: 'A' };

    const stop = asHeld(held, () =>
      watchPageViews(() => viewed.push(pageContext().page!.path)),
    );
    await vi.runAllTimersAsync();
    stop();

    expect(viewed).toEqual(['/a', '/b']);
  });

  describe.each([
    { app: 'empties the title first, as Next.js does', emptying: true },
    { app: 'keeps the old title until it sets the new one', emptying: false },
  ])('for an app that $app', ({ emptying }) => {
    it("waits for the new page's title", async () => {
      const app = navigatingApp({ emptying });
      const { viewed, stop } = watchViews();

      app.navigate('/pricing');
      await vi.advanceTimersByTimeAsync(5);
      app.setTitle('Pricing');
      stop();

      expect(viewed).toEqual(['/ Home', '/pricing Pricing']);
    });

    it('skips a page the app left before its title came', async () => {
      const app = navigatingApp({ emptying });
      const { viewed, stop } = watchViews();

      app.navigate('/about');
      await vi.advanceTimersByTimeAsync(5);
      app.navigate('/docs');
      await vi.advanceTimersByTimeAsync(5);
      app.setTitle('Docs');
      stop();

      expect(viewed).toEqual(['/ Home', '/docs Docs']);
    });
  });

  it('tracks a page whose title stays the same after a moment, as many apps keep one title', async () => {
    const app = navigatingApp({ emptying: false });
    const { viewed, stop } = watchViews();

    app.navigate('/docs');
    await vi.advanceTimersByTimeAsync(99);
    expect(viewed).toEqual(['/ Home']);
    await vi.advanceTimersByTimeAsync(1);
    stop();

    expect(viewed).toEqual(['/ Home', '/docs Home']);
  });

  it('waits up to a second for an emptied title, then tracks the page without one', async () => {
    const app = navigatingApp({ emptying: true });
    const { viewed, stop } = watchViews();

    app.navigate('/untitled');
    await vi.advanceTimersByTimeAsync(999);
    expect(viewed).toEqual(['/ Home']);
    await vi.advanceTimersByTimeAsync(1);
    stop();

    expect(viewed).toEqual(['/ Home', '/untitled ']);
  });
});
