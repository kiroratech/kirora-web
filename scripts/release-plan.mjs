/**
 * Decides whether the release workflow publishes package.json's version, and under which
 * npm dist-tag:
 *
 *   node scripts/release-plan.mjs
 *
 * It writes `publish` and `dist-tag` to $GITHUB_OUTPUT when set, and prints the plan.
 */
import { execFile as execFileCallback } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

/** Compares two `major.minor.patch` versions, ignoring any prerelease part. */
function compare(a, b) {
  const parts = (version) => version.split('-')[0].split('.').map(Number);
  const [x, y] = [parts(a), parts(b)];
  for (let index = 0; index < 3; index++) {
    if (x[index] !== y[index]) {
      return x[index] - y[index];
    }
  }
  return 0;
}

/**
 * The plan for `version`, given the versions already `published` and the current
 * `latest`, if any. Only a stable release newer than `latest` becomes `latest`: a prerelease goes to `next`, and an
 * older maintenance release to `release-<major>.<minor>`, so new installs never move
 * backwards.
 */
export function releasePlan({ version, published, latest }) {
  if (published.includes(version)) {
    return { publish: false, distTag: undefined, reason: `${version} is already on npm` };
  }
  if (version.includes('-')) {
    return { publish: true, distTag: 'next', reason: 'a prerelease' };
  }
  if (latest === undefined || compare(version, latest) > 0) {
    return {
      publish: true,
      distTag: 'latest',
      reason: `newer than ${latest ?? 'nothing'}`,
    };
  }
  const [major, minor] = version.split('.');
  return {
    publish: true,
    distTag: `release-${major}.${minor}`,
    reason: `not newer than latest (${latest})`,
  };
}

/**
 * The versions and `latest` in `npm view <name> versions dist-tags --json`. npm 12 wraps
 * the answer in an array, npm 11 doesn't; either is read the same.
 */
export function registryView(json) {
  const [view = {}] = [].concat(JSON.parse(json));
  return {
    published: [].concat(view.versions ?? []),
    latest: view['dist-tags']?.latest,
  };
}

/**
 * The versions on npm and its `latest`. A package that was never published has none;
 * any other failure throws, rather than being mistaken for "not published yet".
 */
async function registryState(name) {
  try {
    const { stdout } = await promisify(execFileCallback)('npm', [
      'view',
      name,
      'versions',
      'dist-tags',
      '--json',
    ]);
    return registryView(stdout);
  } catch (error) {
    if (/E404/.test(`${error.stdout}${error.stderr}`)) {
      return { published: [], latest: undefined };
    }
    throw error;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { name, version } = JSON.parse(readFileSync('package.json', 'utf8'));
  const plan = releasePlan({ version, ...(await registryState(name)) });
  process.stdout.write(`${name}@${version}: ${JSON.stringify(plan)}\n`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `publish=${plan.publish}\ndist-tag=${plan.distTag ?? ''}\n`,
    );
  }
}
