'use client';

import { signOut } from '@/app/actions';
import { kirora } from '@/lib/kirora';

export function SignOutButton() {
  return (
    <button
      onClick={async () => {
        // Before your own sign-out, so queued events go as this user.
        await kirora.logout().catch((error) => console.error(error));
        await signOut();
      }}
    >
      Sign out
    </button>
  );
}
