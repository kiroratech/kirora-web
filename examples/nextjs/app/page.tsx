import { signIn } from '@/app/actions';
import { PushButton, TrackButton } from '@/components/demo';
import { SignOutButton } from '@/components/sign-out-button';
import { signedInUser } from '@/lib/session';

export default async function Home() {
  const userId = await signedInUser();
  return (
    <main>
      <h1>Home</h1>
      <p>
        Open the console: <code>logLevel: &apos;debug&apos;</code> logs every batch sent.
        Moving between pages tracks <code>Page Viewed</code>.
      </p>
      {userId ? (
        <section>
          <h2>Signed in as {userId}</h2>
          <TrackButton name="Plan Upgraded" properties={{ plan: 'pro', seats: 5 }} />
          <SignOutButton />
        </section>
      ) : (
        <section>
          <h2>Sign in</h2>
          <p>
            A stand-in for your own sign-in. The token route signs whoever is named here.
          </p>
          <form action={signIn}>
            <input name="userId" placeholder="User id, e.g. user-123" required />
            <button>Sign in</button>
          </form>
        </section>
      )}
      <section>
        <h2>Web push</h2>
        <p>Needs a web push app in the Kirora dashboard, and a signed-in user.</p>
        <PushButton />
      </section>
    </main>
  );
}
