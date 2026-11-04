import path from 'node:path';
import type { NextConfig } from 'next';

// @kirora/web comes from this repo's root, outside the app. In your own app, install it
// from npm and drop these.
const repoRoot = path.resolve('../..');

const nextConfig: NextConfig = {
  turbopack: { root: repoRoot },
  outputFileTracingRoot: repoRoot,
};

export default nextConfig;
