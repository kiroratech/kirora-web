'use client';

import { signOut } from '@/app/actions';
import { kirora } from '@/lib/kirora';

export function SignOutButton() {
  return (
    <button
      onClick={async () => {
        // Before your own sign-out, so queued events go as this user. It never rejects
        // and returns within 5 seconds.
        await kirora.logout();
        await signOut();
      }}
    >
      Sign out
    </button>
  );
}
