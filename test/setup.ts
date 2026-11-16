import { beforeEach } from 'vitest';
import { stubLocalStorage } from './fake-kirora.js';

// Every browser the SDK supports has localStorage; a test without it says so itself.
beforeEach(() => {
  stubLocalStorage();
});
