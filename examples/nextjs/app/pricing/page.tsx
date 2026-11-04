import { TrackButton } from '@/components/demo';

export const metadata = { title: 'Pricing · Kirora Next.js example' };

export default function Pricing() {
  return (
    <main>
      <h1>Pricing</h1>
      <p>
        Arriving here by the link above is a client-side navigation, tracked as a page
        view.
      </p>
      <TrackButton name="Product Viewed" properties={{ product_id: 'pro', price: 49 }} />
    </main>
  );
}
