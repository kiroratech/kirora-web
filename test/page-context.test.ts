import { afterEach, expect, it, vi } from 'vitest';
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
});

function pageAt(href: string, canonical?: string) {
  const url = new URL(href);
  vi.stubGlobal('location', url);
  vi.stubGlobal('document', {
    title: 'Pricing',
    referrer: '',
    querySelector: () => (canonical ? { href: canonical } : null),
  });
}

it('names the page by its canonical address, keeping the campaign from the real one', () => {
  pageAt(
    'https://example.com/pricing-b?utm_source=newsletter&email=a@b.c',
    'https://example.com/pricing',
  );
  expect(pageContext()).toMatchObject({
    page: { url: 'https://example.com/pricing', path: '/pricing', title: 'Pricing' },
    campaign: { source: 'newsletter' },
  });
});

it('makes a held call as of when and where the loader saw it', () => {
  pageAt('https://example.com/checkout');
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

it("uses the page's own address when its canonical one is malformed", () => {
  pageAt('https://example.com/pricing?utm_source=newsletter', 'http://[');
  vi.stubGlobal('document', { ...document, referrer: 'not a url' });
  expect(pageContext().page).toEqual({
    url: 'https://example.com/pricing',
    path: '/pricing',
    title: 'Pricing',
  });
});

/** A page with everything the client watches, whose `querySelector` is `querySelector`. */
function browserPage(querySelector: () => unknown) {
  vi.stubGlobal('location', new URL('https://example.com/pricing'));
  vi.stubGlobal('document', {
    title: 'Pricing',
    referrer: '',
    cookie: '',
    visibilityState: 'visible',
    querySelector,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  vi.stubGlobal('history', { pushState: () => undefined, replaceState: () => undefined });
  vi.stubGlobal('addEventListener', () => undefined);
  vi.stubGlobal('removeEventListener', () => undefined);
}

it('still tracks the page when its canonical address is malformed', async () => {
  browserPage(() => ({ href: 'http://[' }));
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
  browserPage(() => {
    throw new Error('broken markup');
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

it('tracks the page the app moved to before the SDK loaded, after the held one', async () => {
  vi.useFakeTimers();
  try {
    pageAt('https://example.com/b');
    vi.stubGlobal('history', {
      pushState: () => undefined,
      replaceState: () => undefined,
    });
    vi.stubGlobal('addEventListener', () => undefined);
    vi.stubGlobal('removeEventListener', () => undefined);
    const viewed: string[] = [];
    const held = { at: Date.now(), href: 'https://example.com/a', title: 'A' };

    const stop = asHeld(held, () =>
      watchPageViews(() => viewed.push(pageContext().page!.path)),
    );
    await vi.runAllTimersAsync();
    stop();
    expect(viewed).toEqual(['/a', '/b']);
  } finally {
    vi.useRealTimers();
  }
});

/** A page that navigates like Next.js: the title is emptied, then set a moment later. */
function navigatingPage() {
  const page = { title: 'Home', referrer: '', head: {}, querySelector: () => null };
  const observers = new Set<() => void>();
  vi.stubGlobal('location', new URL('https://example.com/'));
  vi.stubGlobal('document', page);
  vi.stubGlobal('history', { pushState: () => undefined, replaceState: () => undefined });
  vi.stubGlobal('addEventListener', () => undefined);
  vi.stubGlobal('removeEventListener', () => undefined);
  vi.stubGlobal(
    'MutationObserver',
    class {
      private readonly notify: () => void;
      constructor(callback: () => void) {
        this.notify = callback;
      }
      observe() {
        observers.add(this.notify);
      }
      disconnect() {
        observers.delete(this.notify);
      }
    },
  );
  return {
    navigate(path: string) {
      vi.stubGlobal('location', new URL(path, 'https://example.com'));
      page.title = '';
      history.pushState(null, '', path);
    },
    setTitle(title: string) {
      page.title = title;
      for (const notify of [...observers]) notify();
    },
  };
}

it('waits for the title an app sets after navigating, up to a second', async () => {
  vi.useFakeTimers();
  try {
    const page = navigatingPage();
    const viewed: string[] = [];
    const stop = watchPageViews(() => {
      const { path, title } = pageContext().page!;
      viewed.push(`${path} ${title}`);
    });

    page.navigate('/pricing');
    await vi.advanceTimersByTimeAsync(5);
    page.setTitle('Pricing');
    // Moved on before its title came: only the page it ended on is viewed.
    page.navigate('/about');
    await vi.advanceTimersByTimeAsync(5);
    page.navigate('/docs');
    await vi.advanceTimersByTimeAsync(5);
    page.setTitle('Docs');
    // A page that never gets a title is still viewed, a second later.
    page.navigate('/blank');
    await vi.advanceTimersByTimeAsync(999);
    expect(viewed).toEqual(['/ Home', '/pricing Pricing', '/docs Docs']);
    await vi.advanceTimersByTimeAsync(1);
    stop();

    expect(viewed).toEqual(['/ Home', '/pricing Pricing', '/docs Docs', '/blank ']);
  } finally {
    vi.useRealTimers();
  }
});
