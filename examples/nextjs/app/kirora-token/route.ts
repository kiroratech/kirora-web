import { signedInUser } from '@/lib/session';
import { createUserToken } from '@/lib/user-token';

const noStore = { 'cache-control': 'no-store' };

/** The SDK calls this to prove who's signed in. Sign for your session's user only. */
export async function GET() {
  const userId = await signedInUser();
  if (!userId) return new Response(null, { status: 401, headers: noStore });
  const secret = process.env.KIRORA_SDK_TOKEN_SECRET;
  if (!secret) {
    console.error('KIRORA_SDK_TOKEN_SECRET is not set');
    return new Response(null, { status: 500, headers: noStore });
  }
  return new Response(createUserToken(secret, userId), {
    headers: { ...noStore, 'content-type': 'text/plain' },
  });
}
