import { afterEach, expect, it, vi } from 'vitest';
import { siteStorage } from '../src/storage/site-storage.js';
import { memoryStorage } from './fake-kirora.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A browser's cookies for `host`: one jar, refusing a domain the host is not under or `com`. */
function browserOn(host: string) {
  const jar = new Map<string, { value: string; domain?: string }>();
  const document = {
    get cookie() {
      return [...jar].map(([name, { value }]) => `${name}=${value}`).join('; ');
    },
    set cookie(written: string) {
      const [pair = '', ...attributes] = written.split('; ');
      const [name = '', value = ''] = pair.split('=');
      const attribute = (key: string) =>
        attributes.find((part) => part.startsWith(`${key}=`))?.slice(key.length + 1);
      const domain = attribute('domain');
      if (domain === 'com' || (domain && !`.${host}`.endsWith(`.${domain}`))) return;
      if (attribute('max-age') === '0') jar.delete(name);
      else jar.set(name, { value, domain });
    },
  };
  vi.stubGlobal('document', document);
  vi.stubGlobal('location', { hostname: host, protocol: 'https:' });
  return jar;
}

it('keeps a value in a cookie on the whole site, with a copy on the device', () => {
  const jar = browserOn('app.example.com');
  const device = memoryStorage();
  siteStorage(device).setItem('kirora:installation-id', 'browser-1');

  expect(jar.get('kirora_installation_id')).toEqual({
    value: 'browser-1',
    domain: 'example.com',
  });
  expect(jar.has('kirora_probe')).toBe(false);
  expect(device.getItem('kirora:installation-id')).toBe('browser-1');
  // Another subdomain's page, with nothing of its own, reads the same value.
  expect(siteStorage(memoryStorage()).getItem('kirora:installation-id')).toBe(
    'browser-1',
  );
});

it('shares a value kept by one subdomain alone, once it is read', () => {
  const jar = browserOn('www.example.com');
  const device = memoryStorage();
  device.setItem('kirora:installation-id', 'browser-1');

  expect(siteStorage(device).getItem('kirora:installation-id')).toBe('browser-1');
  expect(jar.get('kirora_installation_id')?.value).toBe('browser-1');
});

it('empties the cookie, without setting one when there was none', () => {
  const jar = browserOn('app.example.com');
  const storage = siteStorage(memoryStorage());
  storage.removeItem('kirora:session');
  expect(jar.size).toBe(0);

  storage.setItem('kirora:session', 'visit-1');
  storage.removeItem('kirora:session');
  expect(jar.get('kirora_session')?.value).toBe('');
  expect(storage.getItem('kirora:session')).toBeNull();
  storage.setItem('kirora:session', 'visit-2');
  expect(storage.getItem('kirora:session')).toBe('visit-2');
});

it("never shares again a value removed on another subdomain, from a page's own copy", () => {
  browserOn('app.example.com');
  const www = memoryStorage();
  siteStorage(www).setItem('kirora:installation-id', 'browser-1');
  // On app., consent is withdrawn; www. still has its own copy on the device.
  siteStorage(memoryStorage()).removeItem('kirora:installation-id');

  expect(siteStorage(www).getItem('kirora:installation-id')).toBeNull();
  expect(www.getItem('kirora:installation-id')).toBeNull();
});

it("falls back to the device's copy where cookies throw, as in a sandboxed iframe", () => {
  const blocked = () => {
    throw new DOMException('The document is sandboxed', 'SecurityError');
  };
  vi.stubGlobal('document', {
    get cookie() {
      return blocked();
    },
    set cookie(_: string) {
      blocked();
    },
  });
  vi.stubGlobal('location', { hostname: 'app.example.com', protocol: 'https:' });
  const device = memoryStorage();
  const storage = siteStorage(device);

  storage.setItem('kirora:session', 'visit-1');
  expect(storage.getItem('kirora:session')).toBe('visit-1');
  storage.removeItem('kirora:session');
  expect(storage.getItem('kirora:session')).toBeNull();
});

it('marks a value removed even once its cookie has expired, so no other subdomain shares it again', () => {
  const jar = browserOn('app.example.com');
  const app = memoryStorage();
  const www = memoryStorage();
  siteStorage(www).setItem('kirora:installation-id', 'browser-1');
  app.setItem('kirora:installation-id', 'browser-1');
  // Safari expired the cookie; then consent is withdrawn on app.
  jar.delete('kirora_installation_id');
  siteStorage(app).removeItem('kirora:installation-id');

  expect(siteStorage(www).getItem('kirora:installation-id')).toBeNull();
});
