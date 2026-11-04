'use client';

import { useEffect } from 'react';
import { kirora } from '@/lib/kirora';

/** Identifies the signed-in user on every page load and after sign-in. */
export function KiroraSession({ userId }: { userId: string | null }) {
  useEffect(() => {
    if (userId) kirora.identify().catch((error) => console.error(error));
  }, [userId]);
  return null;
}
