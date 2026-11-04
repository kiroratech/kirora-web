import { KiroraError, UserTokenError } from '../errors.js';
import type { KiroraOptions } from '../types.js';
import { base64UrlDecode } from '../utils/base64url.js';
import { withTimeout } from '../utils/timeout.js';
import { uuid } from '../utils/uuid.js';

/** A `fetchUserToken` still unanswered after this counts as failed. */
const TOKEN_TIMEOUT_MS = 30_000;

/**
 * One signed-in user. A new object each time the user changes, so work started for a
 * user captures it, and `identity.user === user` tells whether that user is still the
 * one signed in. A refreshed token replaces `token` on the same object.
 */
export type SignedInUser = {
  token: string;
  /**
   * Tells users apart, e.g. to own their queued events: the token's `sub`, unverified
   * (Kirora checks the signature). A token without one can't be told apart from another
   * user's, so it gets an id of its own, new for each sign-in.
   */
  readonly subject: string;
  /** The token's `sub`, or null. A refreshed token must have the same. */
  readonly tokenSubject: string | null;
};

/**
 * Who is signed in, and every rule for moving from one user to the next:
 *
 * - The latest `signIn()` or `end()` wins, whatever order tokens arrive in. `signOut()`
 *   only signs out the user it names, so a newer sign-in still wins.
 * - Work started for one user never carries on as the next: it captures `user`.
 * - A refused token is refreshed once, shared by every call that was refused.
 *
 * The token is kept in memory only.
 */
export class Identity {
  private signedIn: SignedInUser | null = null;
  /** Counts signIn() and end() calls, so only the latest sets the user. */
  private calls = 0;
  /** The latest sign-in, with what follows it. */
  private signingIn: Promise<void> | undefined;
  /** Shared so concurrent refusals only trigger one refresh. */
  private pendingRefresh: Promise<string> | null = null;

  constructor(private readonly fetchUserToken: KiroraOptions['fetchUserToken']) {}

  /** The signed-in user, or null. */
  get user(): SignedInUser | null {
    return this.signedIn;
  }

  /**
   * Signs in with `token`, or one from `fetchUserToken`, then runs `onSignedIn`. Does
   * nothing if a later signIn() or signOut() has decided who's signed in meanwhile.
   * `settled()` waits for all of it.
   */
  async signIn(
    token: string | undefined,
    onSignedIn: () => Promise<void>,
  ): Promise<void> {
    const call = ++this.calls;
    await (this.signingIn = (async () => {
      const userToken = token ?? (await this.fetchToken());
      if (call !== this.calls) return;
      this.setUser(userToken);
      await onSignedIn();
    })());
  }

  /**
   * Signs `user` out, if they're still the one signed in. A signIn() started since keeps
   * going: it's newer, so it wins. True if `user` was signed out.
   */
  signOut(user: SignedInUser): boolean {
    if (this.signedIn !== user) return false;
    this.setUser(null);
    return true;
  }

  /** Signs out whoever is signed in, abandoning any sign-in still waiting for its token. */
  end(): void {
    this.calls++;
    this.setUser(null);
  }

  /** Waits for the latest sign-in. Its own caller handles its errors. */
  async settled(): Promise<void> {
    await this.signingIn?.catch(() => undefined);
  }

  /**
   * A replacement for `user`'s refused token, or null if they're no longer signed in,
   * there's no `fetchUserToken`, or it returned a token for someone else (the app moved
   * on to another user before calling identify()). Reuses a token another call already
   * refreshed.
   */
  async refresh(user: SignedInUser, refusedToken: string): Promise<string | null> {
    if (this.user !== user || !this.fetchUserToken) return null;
    if (user.token !== refusedToken) return user.token;
    const refresh = (this.pendingRefresh ??= this.fetchToken());
    try {
      const userToken = await refresh;
      if (this.user !== user || subjectOf(userToken) !== user.tokenSubject) return null;
      user.token = userToken;
      return userToken;
    } finally {
      if (this.pendingRefresh === refresh) this.pendingRefresh = null;
    }
  }

  private setUser(userToken: string | null): void {
    this.signedIn = userToken === null ? null : signedInUser(userToken);
    this.pendingRefresh = null;
  }

  private async fetchToken(): Promise<string> {
    if (!this.fetchUserToken) {
      throw new KiroraError('pass identify() a user token, or set fetchUserToken');
    }
    try {
      return await withTimeout(this.fetchUserToken(), TOKEN_TIMEOUT_MS);
    } catch (error) {
      throw new UserTokenError(error);
    }
  }
}

/** Starts the subject of a token without `sub`. Prefixed so it can't match a real one. */
const UNNAMED_SUBJECT = 'kirora:unnamed:';

/**
 * True for the subject of an earlier sign-in with a token naming no one. Nobody can sign
 * in as it again, so whatever it owns can never be sent.
 */
export function isUnnamedSubject(subject: string): boolean {
  return subject.startsWith(UNNAMED_SUBJECT);
}

function signedInUser(token: string): SignedInUser {
  const tokenSubject = subjectOf(token);
  return { token, tokenSubject, subject: tokenSubject ?? `${UNNAMED_SUBJECT}${uuid()}` };
}

function subjectOf(userToken: string): string | null {
  try {
    const claims = userToken.split('.')[1];
    if (!claims) return null;
    const { sub } = JSON.parse(base64UrlDecode(claims)) as { sub?: unknown };
    return typeof sub === 'string' && sub !== '' ? sub : null;
  } catch {
    return null;
  }
}
