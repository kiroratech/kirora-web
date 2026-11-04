'use client';

import { useState } from 'react';
import { kirora } from '@/lib/kirora';

export function TrackButton({
  name,
  properties,
}: {
  name: string;
  properties?: Record<string, unknown>;
}) {
  return <button onClick={() => kirora.track(name, properties)}>Track “{name}”</button>;
}

export function PushButton() {
  const [result, setResult] = useState('');
  return (
    <p>
      <button
        onClick={async () => {
          // From the click: browsers block the prompt otherwise.
          try {
            const permission = await kirora.requestPushPermission();
            setResult(`Permission: ${permission}`);
            if (permission === 'granted') await kirora.setPushConsent(true);
          } catch (error) {
            setResult(`Failed: ${(error as Error).message}`);
          }
        }}
      >
        Enable notifications
      </button>{' '}
      {result}
    </p>
  );
}
