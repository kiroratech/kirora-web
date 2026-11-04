import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as {
  version: string;
};

export default defineConfig({
  // As build.mjs writes it in.
  define: { __SDK_VERSION__: JSON.stringify(version) },
});
