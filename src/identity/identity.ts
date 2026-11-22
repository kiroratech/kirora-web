import { KiroraError, UserTokenError } from '../errors.js';
import type { AuthenticationFailureReason, KiroraOptions } from '../types.js';
import { base64UrlDecode } from '../utils/base64url.js';
import { MAX_TIMER_MS, withTimeout } from '../utils/timeout.js';
import { uuid } from '../utils/uuid.js';

/** A `fetchUserToken` still unanswered after this counts as failed. */
const TOKEN_TIMEOUT_MS = 30_000;
/** A token is replaced this long before its `exp`, so no request carries an expired one. */
const REFRESH_AHEAD_MS = 60_000;
/** A failed early refresh is tried again after this, while the token still works. */
const REFRESH_RETRY_MS = 15_000;

/**
 * One signed-in user. A new object each time the user changes, so work started for a
 * user captures it, and `identity.user === user` tells whether that user is still the
 * one signed in. A refreshed token replaces `token` on the same object.
 */
export type SignedInUser = {
  token: string;
  /**
   * When `token` stops working, by this device's clock (epoch ms), set as it arrives;
   * undefined if it can't be told. It's replaced a minute before.
   */
  expiresAt: number | undefined;
  /**
   * Tells users apart, e.g. to own their queued events: the token's `sub`, unverified
   * (Kirora checks the signature). A token without one can't be told apart from another
   * user's, so it gets an id of its own, new for each sign-in.
   */
  readonly subject: string;
  /** The token's `sub`, or null. A refreshed token must have the same. */
  readonly tokenSubject: string | null;
  /**
   * How many logout() calls are signing this user out, as two may overlap: a failure on
   * the way out isn't the app's to hear.
   */
  leaving?: number;
  /**
   * Kirora refused this user's token and there's no `fetchUserToken` to ask for another:
   * every call as them would be refused too, until identify() signs in again.
   */
  refused?: true;
  /**
   * Kirora accepted this sign-in's token on some request: the sign-in stands, whatever
   * is refused later. Kept on the user, so a request finishing late for an earlier one
   * can't speak for this one.
   */
  accepted?: true;
};

/**
 * Who is signed in, and every rule for moving from one user to the next:
 *
 * - The latest `signIn()` or `end()` wins, whatever order tokens arrive in. `signOut()`
 *   only signs out the user it names, so a newer sign-in still wins.
 * - Work started for one user never carries on as the next: it captures `user`.
 * - A refused token is refreshed once, shared by every call that was refused. Without
 *   `fetchUserToken` it's refused for good: no call goes as that user again.
 * - With `fetchUserToken`, a token is also refreshed a minute before it expires, and
 *   retried until it has; only a failure after that is reported.
 * - A token failing in the background is reported to the app once, until it's accepted
 *   again or identify() is called.
 *
 * The token is kept in memory only.
 */
/** A sign-in identify() is still finishing, and a token failure held back meanwhile. */
type SignInUnderWay = { user: SignedInUser; held?: AuthenticationFailureReason };

export class Identity {
  private signedIn: SignedInUser | null = null;
  /** Counts signIn() and end() calls, so only the latest sets the user. */
  private calls = 0;
  /** The latest sign-in, with what follows it. */
  private signingIn: Promise<void> | undefined;
  /** Shared so concurrent refusals only trigger one refresh. */
  private pendingRefresh: Promise<string> | null = null;
  /** Asks for a fresh token before the current one expires. */
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  /** The user whose token failure the app was told of, so it's told once. */
  private failureReported: SignedInUser | null = null;
  /**
   * The user identify() is still signing in, and a token failure held back meanwhile:
   * if identify() rejects for it, the app hears of it there, so it's reported once.
   */
  private identifying: SignInUnderWay | null = null;

  /** Who other tabs are told is signed in here, and how to stop telling them. */
  private presence: { subject: string; release: () => void } | undefined;

  constructor(
    private readonly fetchUserToken: KiroraOptions['fetchUserToken'],
    private readonly onFailed?: (reason: AuthenticationFailureReason) => void,
    /**
     * Tells other tabs `subject` is signed in here, until the returned function is
     * called (see `holdSignedIn`).
     */
    private readonly announce?: (subject: string) => () => void,
  ) {}

  /** The signed-in user, or null. */
  get user(): SignedInUser | null {
    return this.signedIn;
  }

  /**
   * Who owns what's tracked now: the signed-in user, unless logout() is signing them out,
   * when it's whoever signs in next.
   */
  get owner(): SignedInUser | null {
    const user = this.signedIn;
    return user && !user.leaving ? user : null;
  }

  /** Changes with every signIn() and end(), so a caller can tell if either happened since. */
  get generation(): number {
    return this.calls;
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
    this.signingIn = this.completeSignIn(call, token, onSignedIn);
    await this.signingIn;
  }

  /** The rest of signIn() number `call`, which `settled()` waits for. */
  private async completeSignIn(
    call: number,
    token: string | undefined,
    onSignedIn: () => Promise<void>,
  ): Promise<void> {
    const userToken = token ?? (await this.fetchToken());
    // A later signIn() or signOut() decided who's signed in meanwhile.
    if (call !== this.calls) {
      return;
    }

    const user = signedInUser(userToken);
    this.setUser(user);
    const identifying: SignInUnderWay = { user };
    this.identifying = identifying;

    try {
      await onSignedIn();
    } catch (error) {
      // identify() rejects for the token: that's the app's one report of it.
      this.failureReported = user;
      throw error;
    } finally {
      if (this.identifying === identifying) {
        this.identifying = null;
      }
    }

    if (identifying.held) {
      this.authFailed(user, identifying.held);
    }
  }

  /**
   * Signs `user` out, if they're still the one signed in. A signIn() started since keeps
   * going: it's newer, so it wins. True if `user` was signed out.
   */
  signOut(user: SignedInUser): boolean {
    if (this.signedIn !== user) {
      return false;
    }
    this.setUser(null);
    return true;
  }

  /** Signs out whoever is signed in, abandoning any sign-in still waiting for its token. */
  end(): void {
    this.calls++;
    this.setUser(null);
  }

  /**
   * Tells the app `user`'s token failed in the background, if they're still signed in and
   * it hasn't been told since their token was last accepted or identify() was called.
   */
  authFailed(user: SignedInUser, reason: AuthenticationFailureReason): void {
    if (this.owner !== user || this.failureReported === user) {
      return;
    }
    if (this.identifying?.user === user) {
      this.identifying.held ??= reason;
      return;
    }
    this.failureReported = user;
    // Apart from the SDK's own work, and only if it still stands then: another sign-in,
    // logout(), destroy() or an accepted token may have come first.
    setTimeout(() => {
      if (this.owner === user && this.failureReported === user) {
        this.onFailed?.(reason);
      }
    });
  }

  /**
   * Waits for a token refresh under way for `user`, so a request doesn't go with the
   * token it's about to replace (e.g. as the page is shown again). Never rejects.
   */
  async tokenReady(user: SignedInUser): Promise<void> {
    if (this.signedIn === user) {
      await this.pendingRefresh?.catch(() => undefined);
    }
  }

  /** Kirora accepted `user`'s token: a later failure is news again. */
  tokenAccepted(user: SignedInUser): void {
    user.accepted = true;
    if (this.failureReported === user) {
      this.failureReported = null;
    }
  }

  /** logout() is signing `user` out: a failure on the way out isn't the app's to hear. */
  signingOut(user: SignedInUser): void {
    user.leaving = (user.leaving ?? 0) + 1;
  }

  /** A logout() of `user` is done: once none is left, their failures are news again. */
  signedOut(user: SignedInUser): void {
    user.leaving!--;
  }

  /**
   * Asks for a fresh token if the current one expires within a minute. On a timer, and as
   * the page is shown again, since browsers hold back timers in hidden tabs.
   */
  refreshIfDue(): void {
    const user = this.signedIn;
    if (!user || !this.fetchUserToken) {
      return;
    }
    const { expiresAt } = user;
    if (expiresAt === undefined) {
      return;
    }
    if (Date.now() < expiresAt - REFRESH_AHEAD_MS) {
      this.setTimer(expiresAt - REFRESH_AHEAD_MS);
      return;
    }
    // A token for someone else is ignored: the current one goes until it's refused.
    const { token } = user;
    this.refresh(user, token).catch((error: unknown) => {
      // Signed out, or another call got a token meanwhile.
      if (
        !(error instanceof UserTokenError) ||
        this.signedIn !== user ||
        user.token !== token
      ) {
        return;
      }
      // Tried again while the token works, last as it expires; the app hears only of a
      // refresh that failed once it had.
      const now = Date.now();
      if (now < expiresAt) {
        this.setTimer(Math.min(now + REFRESH_RETRY_MS, expiresAt));
        return;
      }
      this.authFailed(user, 'fetch_failed');
    });
  }

  /** True if Kirora refused `user`'s token and it can't be replaced. */
  tokenRefused(user: SignedInUser): boolean {
    return user.refused === true;
  }

  /** Lets a sign-in still waiting for its token set no one, keeping whoever is signed in. */
  abandonSignIn(): void {
    this.calls++;
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
    if (!this.fetchUserToken) {
      user.refused = true;
      return null;
    }
    if (this.signedIn !== user) {
      return null;
    }
    if (user.token !== refusedToken) {
      return user.token;
    }

    this.pendingRefresh ??= this.fetchToken();
    const refresh = this.pendingRefresh;
    try {
      const userToken = await refresh;
      if (this.signedIn !== user) {
        return null;
      }
      // Only a token naming the same user: one naming no one can't be told apart from
      // another user's.
      const subject = subjectOf(userToken);
      if (subject === null || subject !== user.tokenSubject) {
        return null;
      }

      user.token = userToken;
      user.expiresAt = expiresAtOf(userToken, true);
      // Sets the next refresh, a minute before it expires.
      this.setTimer(0);
      return userToken;
    } finally {
      if (this.pendingRefresh === refresh) {
        this.pendingRefresh = null;
      }
    }
  }

  private setUser(user: SignedInUser | null): void {
    this.signedIn = user;
    this.pendingRefresh = null;
    clearTimeout(this.refreshTimer);
    // Sets the first refresh, a minute before the token expires.
    if (this.signedIn) {
      this.setTimer(0);
    }
    this.announceSignedIn(user ? user.subject : null);
  }

  /**
   * Tells other tabs who is signed in here, for as long as they are: another tab's
   * logout() with nobody signed in then leaves their push registration alone. The same
   * user signing in again keeps what's there.
   */
  private announceSignedIn(subject: string | null): void {
    if (this.presence?.subject === subject) {
      return;
    }
    this.presence?.release();
    this.presence = undefined;
    if (subject !== null && this.announce) {
      this.presence = { subject, release: this.announce(subject) };
    }
  }

  /**
   * Checks at `at` (epoch ms) whether the signed-in user's token is due, replacing the
   * timer set before: a new user's sign-in replaces it too.
   */
  private setTimer(at: number): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(
      () => this.refreshIfDue(),
      Math.min(Math.max(at - Date.now(), 0), MAX_TIMER_MS),
    );
    // In Node, as when server rendering, a refresh timer mustn't keep the process alive.
    (this.refreshTimer as unknown as { unref?: () => void }).unref?.();
  }

  private async fetchToken(): Promise<string> {
    if (!this.fetchUserToken) {
      throw new KiroraError('pass identify() a user token, or set fetchUserToken');
    }
    try {
      const token = await withTimeout(this.fetchUserToken(), TOKEN_TIMEOUT_MS);
      // No token is a failed fetch, never an empty token sent to Kirora.
      if (typeof token !== 'string' || token === '') {
        throw new Error('fetchUserToken returned no token');
      }
      return token;
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
  return {
    token,
    expiresAt: expiresAtOf(token, false),
    tokenSubject,
    subject: tokenSubject ?? `${UNNAMED_SUBJECT}${uuid()}`,
  };
}

/** The token's claims, unverified (Kirora checks the signature), or none. */
function claimsOf(userToken: string): { sub?: unknown; exp?: unknown; iat?: unknown } {
  try {
    const claims = userToken.split('.')[1];
    if (!claims) {
      return {};
    }
    const parsed = JSON.parse(base64UrlDecode(claims)) as unknown;
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function subjectOf(userToken: string): string | null {
  const { sub } = claimsOf(userToken);
  return typeof sub === 'string' && sub !== '' ? sub : null;
}

/**
 * When `userToken`, just arrived, stops working (epoch ms): at its `exp`.
 *
 * One already past it as it arrives, or issued in the future, meets a device clock that's
 * off, so its lifetime (`exp` less `iat`) is counted from now instead.
 *
 * Undefined if that can't be told, or for one a refresh just gave that's due at once:
 * asking again would get the same, so it's replaced once Kirora refuses it. Either way it
 * waits for a refusal.
 */
function expiresAtOf(userToken: string, refreshed: boolean): number | undefined {
  const { exp, iat } = claimsOf(userToken);
  if (!isTime(exp)) {
    return undefined;
  }

  const now = Date.now();
  let expiresAt = exp * 1000;

  // Already expired as it arrives: the clock may be ahead. Issued in the future (by more
  // than a refresh's lead): the clock is behind.
  const expiredOnArrival = expiresAt <= now;
  const issuedInFuture = isTime(iat) && iat * 1000 > now + REFRESH_AHEAD_MS;
  if (expiredOnArrival || issuedInFuture) {
    if (!isTime(iat)) {
      return undefined;
    }
    expiresAt = now + (exp - iat) * 1000;
  }

  const dueAtOnce = expiresAt - REFRESH_AHEAD_MS <= now;
  if (refreshed && dueAtOnce) {
    return undefined;
  }
  return expiresAt;
}

function isTime(claim: unknown): claim is number {
  return typeof claim === 'number' && Number.isFinite(claim);
}
