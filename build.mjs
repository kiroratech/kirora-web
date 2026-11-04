// Writes dist/: the ES module, the <script> build, the service worker and the types.
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { build } from 'esbuild';

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const shared = {
  bundle: true,
  // The browsers the README promises. Safari 14.0 is in too: esbuild only refuses it for a
  // destructuring bug (WebKit 220517) our code doesn't hit, and can't lower destructuring.
  target: ['chrome80', 'firefox74', 'safari14.1'],
  sourcemap: true,
  define: { __SDK_VERSION__: JSON.stringify(version) },
};

rmSync('dist', { recursive: true, force: true });
// Independent, so built together.
await Promise.all([
  build({
    ...shared,
    entryPoints: ['src/index.ts'],
    format: 'esm',
    outfile: 'dist/index.js',
  }),
  build({
    ...shared,
    entryPoints: ['src/cdn.ts'],
    format: 'iife',
    minify: true,
    outfile: 'dist/kirora.min.js',
  }),
  // Not minified: sites serve it from their own origin, so it stays readable there.
  build({
    ...shared,
    entryPoints: ['src/push/worker/kirora-sw.ts'],
    format: 'iife',
    outfile: 'dist/kirora-sw.js',
  }),
]);
execFileSync('tsc', ['-p', 'tsconfig.build.json'], { stdio: 'inherit' });
