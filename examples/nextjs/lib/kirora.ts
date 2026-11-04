import { Kirora } from '@kirora/web';

/**
 * One client for the whole app, created outside components. Importing it during server
 * rendering is safe: it touches no browser APIs and sends nothing until `identify()`.
 */
export const kirora = new Kirora({
  clientKey: process.env.NEXT_PUBLIC_KIRORA_CLIENT_KEY ?? '',
  apiUrl: process.env.NEXT_PUBLIC_KIRORA_API_URL || undefined,
  fetchUserToken: async () => {
    const response = await fetch('/kirora-token');
    // Throw on errors: the SDK keeps queued events and retries later.
    if (!response.ok) throw new Error(`Token request failed: ${response.status}`);
    return response.text();
  },
  trackPageViews: true,
  push: true,
  logLevel: 'debug',
});
