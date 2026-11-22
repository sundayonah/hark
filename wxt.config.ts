import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  vite: () => ({ plugins: [tailwindcss()] }),
  manifest: {
    name: 'Hark',
    description: 'Reads important Gmail messages out loud the moment they arrive.',
    permissions: ['identity', 'storage', 'alarms', 'tts'],
    host_permissions: ['https://gmail.googleapis.com/*', 'https://oauth2.googleapis.com/*'],
    // Optional: pin the extension ID so the OAuth redirect URI never changes.
    // key: 'YOUR_PUBLIC_KEY',
  },
});
