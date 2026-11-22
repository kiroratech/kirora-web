import { describe, it, expect } from 'vitest';
import { registryView, releasePlan } from './release-plan.mjs';

describe('releasePlan', () => {
  const plan = (version, published = [], latest = undefined) => {
    const { publish, distTag } = releasePlan({ version, published, latest });
    return { publish, distTag };
  };

  it('publishes the first release as latest', () => {
    expect(plan('0.1.0')).toEqual({ publish: true, distTag: 'latest' });
  });

  it('makes the first release latest after the placeholder that created the package', () => {
    expect(plan('0.1.0', ['0.0.0-stage'], undefined)).toEqual({
      publish: true,
      distTag: 'latest',
    });
    expect(plan('0.1.0', ['0.0.0-stage'], '0.0.0-stage')).toEqual({
      publish: true,
      distTag: 'latest',
    });
  });

  it('makes a newer stable release latest', () => {
    expect(plan('1.3.0', ['1.2.0'], '1.2.0')).toEqual({
      publish: true,
      distTag: 'latest',
    });
    expect(plan('1.10.0', ['1.9.0'], '1.9.0')).toEqual({
      publish: true,
      distTag: 'latest',
    });
  });

  it('never moves latest back for an older maintenance release', () => {
    expect(plan('1.1.5', ['1.1.4', '1.2.0'], '1.2.0')).toEqual({
      publish: true,
      distTag: 'release-1.1',
    });
  });

  it('publishes a prerelease to next', () => {
    expect(plan('2.0.0-beta.1', ['1.2.0'], '1.2.0')).toEqual({
      publish: true,
      distTag: 'next',
    });
  });

  it('skips a version already on npm', () => {
    expect(plan('1.2.0', ['1.2.0'], '1.2.0')).toEqual({
      publish: false,
      distTag: undefined,
    });
  });
});

describe('registryView', () => {
  const view = { versions: ['0.1.0', '0.2.0'], 'dist-tags': { latest: '0.2.0' } };
  const expected = { published: ['0.1.0', '0.2.0'], latest: '0.2.0' };

  it('reads npm 11, which answers an object', () => {
    expect(registryView(JSON.stringify(view))).toEqual(expected);
  });

  it('reads npm 12, which wraps the answer in an array', () => {
    expect(registryView(JSON.stringify([view]))).toEqual(expected);
  });

  it('reads a package with a single version, whose versions npm gives as a string', () => {
    const single = { versions: '0.1.0', 'dist-tags': { latest: '0.1.0' } };
    expect(registryView(JSON.stringify(single))).toEqual({
      published: ['0.1.0'],
      latest: '0.1.0',
    });
  });
});
