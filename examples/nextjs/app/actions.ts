'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE } from '@/lib/session';

export async function signIn(form: FormData) {
  const userId = String(form.get('userId') ?? '').trim();
  if (userId) {
    (await cookies()).set(SESSION_COOKIE, userId, { httpOnly: true, sameSite: 'lax' });
  }
  redirect('/');
}

export async function signOut() {
  (await cookies()).delete(SESSION_COOKIE);
  redirect('/');
}
