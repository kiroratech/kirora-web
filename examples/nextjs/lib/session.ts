import { cookies } from 'next/headers';

/** Stands in for your real auth: whoever is named in the `demo_user` cookie. */
export const SESSION_COOKIE = 'demo_user';

export async function signedInUser(): Promise<string | null> {
  return (await cookies()).get(SESSION_COOKIE)?.value ?? null;
}
