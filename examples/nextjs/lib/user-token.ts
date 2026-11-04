import { createHmac } from 'node:crypto';

/**
 * What `createUserToken` in `@kirora/node` does: an HS256 JWT naming your user, valid for
 * an hour. Server-only: the secret must never reach the browser.
 */
export function createUserToken(secret: string, userId: string, expiresInSeconds = 3600) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const encode = (part: object) =>
    Buffer.from(JSON.stringify(part)).toString('base64url');
  const signingInput = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({
    sub: userId,
    iat: issuedAt,
    exp: issuedAt + expiresInSeconds,
  })}`;
  const signature = createHmac('sha256', secret).update(signingInput).digest('base64url');
  return `${signingInput}.${signature}`;
}
