import Link from 'next/link';
import { Suspense, type ReactNode } from 'react';
import { KiroraSession } from '@/components/kirora-session';
import { signedInUser } from '@/lib/session';

export const metadata = { title: 'Kirora Next.js example' };

/**
 * Reads the session apart from the layout, inside <Suspense>, so the rest of the page can
 * still be prerendered (and builds with `cacheComponents` on).
 */
async function KiroraSessionFromCookies() {
  return <KiroraSession userId={await signedInUser()} />;
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          font: '16px/1.5 system-ui, sans-serif',
          maxWidth: '40rem',
          margin: '2rem auto',
          padding: '0 1rem',
        }}
      >
        <Suspense fallback={null}>
          <KiroraSessionFromCookies />
        </Suspense>
        <nav>
          <Link href="/">Home</Link> · <Link href="/pricing">Pricing</Link>
        </nav>
        {children}
      </body>
    </html>
  );
}
