import { expect, it } from 'vitest';
import { Identity } from '../src/identity/identity.js';
import { tokenFor } from './fake-kirora.js';

/** A `fetchUserToken` whose answers the test hands out. */
function controlledTokens() {
  const answers: ((token: string) => void)[] = [];
  const fetchUserToken = () => new Promise<string>((resolve) => answers.push(resolve));
  return { fetchUserToken, answers };
}

const nothing = () => Promise.resolve();

it('lets the latest sign-in win, whatever order tokens arrive in', async () => {
  const { fetchUserToken, answers } = controlledTokens();
  const identity = new Identity(fetchUserToken);
  const alice = identity.signIn(undefined, nothing);
  const bob = identity.signIn(undefined, nothing);
  answers[1]!(tokenFor('bob'));
  await bob;
  answers[0]!(tokenFor('alice'));
  await alice;
  expect(identity.user?.subject).toBe('bob');
});

it('signs out only the user it was asked to, leaving a newer sign-in going', async () => {
  const { fetchUserToken, answers } = controlledTokens();
  const identity = new Identity(fetchUserToken);
  await identity.signIn(tokenFor('alice'), nothing);
  const alice = identity.user!;
  const bob = identity.signIn(undefined, nothing);
  expect(identity.signOut(alice)).toBe(true);
  expect(identity.user).toBeNull();
  answers[0]!(tokenFor('bob'));
  await bob;
  // Alice's sign-out is stale now, so it changes nothing.
  expect(identity.signOut(alice)).toBe(false);
  expect(identity.user?.subject).toBe('bob');
});

it('ignores a token that arrives after ending', async () => {
  const { fetchUserToken, answers } = controlledTokens();
  const identity = new Identity(fetchUserToken);
  const signingIn = identity.signIn(undefined, nothing);
  identity.end();
  answers[0]!(tokenFor('alice'));
  await signingIn;
  expect(identity.user).toBeNull();
});

it('settles only once the work after signing in is done', async () => {
  const identity = new Identity(undefined);
  let finish: () => void = () => undefined;
  const signingIn = identity.signIn(
    tokenFor('alice'),
    () => new Promise<void>((resolve) => (finish = resolve)),
  );
  let settled = false;
  const waiting = identity.settled().then(() => (settled = true));
  await Promise.resolve();
  expect(settled).toBe(false);
  finish();
  await Promise.all([signingIn, waiting]);
  expect(settled).toBe(true);
});

it('refreshes once for every call refused at the same time', async () => {
  let fetched = 0;
  const identity = new Identity(() =>
    Promise.resolve(tokenFor('alice', `-${++fetched}`)),
  );
  await identity.signIn(tokenFor('alice'), nothing);
  const alice = identity.user!;
  const refused = alice.token;
  const fresh = await Promise.all([
    identity.refresh(alice, refused),
    identity.refresh(alice, refused),
  ]);
  expect(fetched).toBe(1);
  expect(fresh).toEqual([tokenFor('alice', '-1'), tokenFor('alice', '-1')]);
});

it('never refreshes for a user who is no longer signed in', async () => {
  const identity = new Identity(() => Promise.resolve(tokenFor('alice', '-fresh')));
  await identity.signIn(tokenFor('alice'), nothing);
  const alice = identity.user!;
  await identity.signIn(tokenFor('bob'), nothing);
  expect(await identity.refresh(alice, alice.token)).toBeNull();
  expect(identity.user?.subject).toBe('bob');
});

it("never takes a refreshed token for someone else as the user's own", async () => {
  // The app switched its session to Bob before calling identify() for him.
  const identity = new Identity(() => Promise.resolve(tokenFor('bob')));
  await identity.signIn(tokenFor('alice'), nothing);
  const alice = identity.user!;
  expect(await identity.refresh(alice, alice.token)).toBeNull();
  expect(alice.token).toBe(tokenFor('alice'));
});

it('tells apart users whose tokens name no one', async () => {
  const identity = new Identity(undefined);
  await identity.signIn('opaque-token', nothing);
  const first = identity.user!.subject;
  await identity.signIn('opaque-token', nothing);
  expect(identity.user!.subject).not.toBe(first);
  expect(identity.user!.subject).not.toBeNull();
});
