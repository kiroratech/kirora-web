// A tiny site for the script-tag example: two pages, a stand-in sign-in, and the token
// route the SDK calls. No dependencies: run it with `node server.mjs`.
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const clientKey = process.env.KIRORA_CLIENT_KEY;
const tokenSecret = process.env.KIRORA_SDK_TOKEN_SECRET;
const apiUrl = process.env.KIRORA_API_URL;
const port = Number(process.env.PORT ?? 3000);
if (!clientKey || !tokenSecret) {
  console.error('Set KIRORA_CLIENT_KEY and KIRORA_SDK_TOKEN_SECRET. See README.md.');
  process.exit(1);
}

const dist = new URL('../../dist/', import.meta.url);
const template = readFileSync(new URL('index.html', import.meta.url), 'utf8');
const pages = { '/': 'Home', '/pricing': 'Pricing' };

/**
 * What `createUserToken` in `@kirora/node` does: an HS256 JWT naming your user, valid for
 * an hour. Kirora refuses one valid for more than 24 hours.
 */
function createUserToken(secret, userId, expiresInSeconds = 60 * 60) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const encode = (part) => Buffer.from(JSON.stringify(part)).toString('base64url');
  const signingInput = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({
    sub: userId,
    iat: issuedAt,
    exp: issuedAt + expiresInSeconds,
  })}`;
  const signature = createHmac('sha256', secret).update(signingInput).digest('base64url');
  return `${signingInput}.${signature}`;
}

/** Stands in for your real sign-in: whoever is named in the `demo_user` cookie. */
function signedInUser(request) {
  const match = /(?:^|; )demo_user=([^;]+)/.exec(request.headers.cookie ?? '');
  return match ? decodeURIComponent(match[1]) : null;
}

/** For values written into a <script> block. */
function scriptValue(value) {
  return JSON.stringify(value ?? null).replace(/</g, '\\u003c');
}

async function formField(request, name) {
  let body = '';
  for await (const chunk of request) body += chunk;
  return new URLSearchParams(body).get(name);
}

createServer(async (request, response) => {
  const { pathname } = new URL(request.url, 'http://localhost');
  const user = signedInUser(request);

  if (pathname === '/kirora-token') {
    const noStore = { 'cache-control': 'no-store' };
    if (!user) return response.writeHead(401, noStore).end();
    return response
      .writeHead(200, { ...noStore, 'content-type': 'text/plain' })
      .end(createUserToken(tokenSecret, user));
  }
  if (pathname === '/sign-in' && request.method === 'POST') {
    const userId = (await formField(request, 'userId'))?.trim();
    const cookie = userId
      ? `demo_user=${encodeURIComponent(userId)}; Path=/; HttpOnly; SameSite=Lax`
      : undefined;
    return response.writeHead(303, { location: '/', 'set-cookie': cookie ?? [] }).end();
  }
  if (pathname === '/sign-out' && request.method === 'POST') {
    return response
      .writeHead(303, { location: '/', 'set-cookie': 'demo_user=; Path=/; Max-Age=0' })
      .end();
  }
  // The local build. On your own site, load kirora.min.js from the CDN and copy
  // kirora-sw.js to your site's root.
  if (pathname === '/kirora.min.js' || pathname === '/kirora-sw.js') {
    try {
      const file = readFileSync(new URL(pathname.slice(1), dist));
      return response.writeHead(200, { 'content-type': 'text/javascript' }).end(file);
    } catch {
      return response.writeHead(404).end('Run `pnpm build` in the repo root first.');
    }
  }
  const title = pages[pathname];
  if (!title) return response.writeHead(404).end('Not found');
  const html = template
    .replaceAll('__PAGE_TITLE__', title)
    .replace(
      '__KIRORA_OPTIONS__',
      scriptValue({ clientKey, ...(apiUrl ? { apiUrl } : {}) }),
    )
    .replace('__SIGNED_IN_USER__', scriptValue(user));
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
}).listen(port, () => console.log(`Script-tag example on http://localhost:${port}`));
