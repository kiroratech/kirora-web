import { describe, it, expect } from 'vitest';
import { releasePlan } from './release-plan.mjs';

describe('releasePlan', () => {
  const plan = (version, published = [], latest = undefined, tag = undefined) => {
    const { publish, distTag } = releasePlan({ version, tag, published, latest });
    return { publish, distTag };
  };

  it('publishes the first release as latest', () => {
    expect(plan('0.1.0')).toEqual({ publish: true, distTag: 'latest' });
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

  it('refuses a tag that names another version', () => {
    expect(() => plan('1.2.0', [], undefined, 'v1.2.1')).toThrow("doesn't match");
    expect(plan('1.2.0', [], undefined, 'v1.2.0').publish).toBe(true);
  });
});
