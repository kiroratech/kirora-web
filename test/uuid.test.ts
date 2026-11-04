import { afterEach, expect, it, vi } from 'vitest';
import { uuid } from '../src/utils/uuid.js';

const realCrypto = globalThis.crypto;

afterEach(() => {
  vi.unstubAllGlobals();
});

it('makes v4 UUIDs without crypto.randomUUID, as on plain http pages', () => {
  vi.stubGlobal('crypto', {
    getRandomValues: (bytes: Uint8Array) => realCrypto.getRandomValues(bytes),
  });
  const ids = new Set(Array.from({ length: 100 }, () => uuid()));

  expect(ids.size).toBe(100);
  for (const id of ids) {
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  }
});
