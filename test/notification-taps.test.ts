import { afterEach, expect, it, vi } from 'vitest';
import { fakeKirora, pushClient, stubWebPush } from './fake-kirora.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * A page with push granted, whose service worker can hand it taps. `asked` records what
 * the page said to the worker.
 */
async function pageWithWorker() {
  stubWebPush();
  fakeKirora();
  vi.stubGlobal('document', {
    visibilityState: 'visible',
    title: '',
    referrer: '',
    cookie: '',
    querySelector: () => null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  vi.stubGlobal('addEventListener', () => undefined);
  vi.stubGlobal('removeEventListener', () => undefined);
  const container = navigator.serviceWorker as unknown as Record<string, unknown>;
  const registration = await (
    container.getRegistration as () => Promise<{ active: Record<string, unknown> }>
  )();
  const asked: unknown[] = [];
  registration.active.postMessage = (message: unknown) => asked.push(message);
  let onMessage: ((event: { data: unknown }) => void) | undefined;
  container.addEventListener = (type: string, listener: typeof onMessage) => {
    if (type === 'message') {
      onMessage = listener;
    }
  };
  container.removeEventListener = () => (onMessage = undefined);
  const workerSays = (data: unknown) => onMessage?.({ data });
  return { asked, workerSays };
}

const tapMessage = (id: string, data: Record<string, unknown>) => ({
  kirora: 'notificationClick',
  id,
  data,
});

it("hands the page's listeners each tap's data once, holding taps until one listens", async () => {
  const { asked, workerSays } = await pageWithWorker();
  const kirora = pushClient();
  workerSays(tapMessage('tap-1', { orderId: '42', ignored: 7 }));
  // Nothing listens yet, so the worker isn't woken to ask for a held tap.
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(asked).toEqual([]);

  const heard: Record<string, string>[] = [];
  kirora.addNotificationClickListener((data) => heard.push(data));
  expect(heard).toEqual([{ orderId: '42' }]);
  // Now it asks the worker for a tap held for this page.
  await vi.waitFor(() => expect(asked).toEqual([{ kirora: 'listening' }]));

  // The worker hands a tap over twice when the page asks for it after it was sent.
  workerSays(tapMessage('tap-2', { screen: 'inbox' }));
  workerSays(tapMessage('tap-2', { screen: 'inbox' }));
  workerSays({ kirora: 'somethingElse' });
  workerSays('not ours');
  expect(heard).toEqual([{ orderId: '42' }, { screen: 'inbox' }]);

  const removed = (data: Record<string, string>) => heard.push(data);
  kirora.addNotificationClickListener(removed);
  kirora.removeNotificationClickListener(removed);
  workerSays(tapMessage('tap-3', {}));
  expect(heard).toHaveLength(3);
  // Asked once, however many listeners come.
  expect(asked).toHaveLength(1);
  kirora.destroy();
});

it('keeps telling listeners when one throws, and stops listening once destroyed', async () => {
  const { workerSays } = await pageWithWorker();
  const kirora = pushClient();
  const heard: string[] = [];
  kirora.addNotificationClickListener(() => {
    throw new Error('the app broke');
  });
  kirora.addNotificationClickListener((data) => heard.push(data.orderId!));
  workerSays(tapMessage('tap-1', { orderId: '42' }));
  expect(heard).toEqual(['42']);

  kirora.destroy();
  workerSays(tapMessage('tap-2', { orderId: '43' }));
  expect(heard).toEqual(['42']);
});

it("doesn't wake the worker where notifications aren't allowed", async () => {
  const { asked } = await pageWithWorker();
  vi.stubGlobal('Notification', { permission: 'default' });
  const kirora = pushClient();
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(asked).toEqual([]);
  kirora.destroy();
});

it('hears taps once permission is granted after the page loaded', async () => {
  const { asked, workerSays } = await pageWithWorker();
  const notification = {
    permission: 'default',
    requestPermission: () => Promise.resolve((notification.permission = 'granted')),
  };
  vi.stubGlobal('Notification', notification);
  const kirora = pushClient();
  const heard: string[] = [];
  kirora.addNotificationClickListener((data) => heard.push(data.orderId!));

  expect(await kirora.requestPushPermission()).toBe('granted');
  // A tap that brings this tab forward.
  workerSays(tapMessage('tap-1', { orderId: '42' }));
  expect(heard).toEqual(['42']);
  // No tap could have opened this page, so the worker was never asked for one.
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(asked).toEqual([]);
  kirora.destroy();
});
