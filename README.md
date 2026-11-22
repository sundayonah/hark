# Hark

A Chrome extension that reads Gmail messages from senders you choose out loud, as they arrive.

Stack: WXT, Vite, TypeScript, Tailwind CSS v4, Manifest V3.

## How it feels to use

1. Click the Hark icon. You see **Connect Gmail**.
2. Click it. Google's account picker opens, so you can choose any Gmail account.
3. Type a sender (`mercor.com`, `name@mercor.com`, or a name) and press Enter or **Add**. Add as many as you like.
4. Hark checks every minute and reads new mail from those senders aloud.

## Setup

```bash
npm install
npm run dev
```

### Google OAuth client (one time)

1. https://console.cloud.google.com → create a project → **APIs & Services → Library** → enable **Gmail API**.
2. **OAuth consent screen** → External. Add every Gmail you want to connect under **Test users**.
3. Find your redirect URL: load the extension, open its service worker console from `chrome://extensions`, and run
   `chrome.identity.getRedirectURL()`. It looks like `https://<extension-id>.chromiumapp.org/`.
4. **Credentials → Create credentials → OAuth client ID** → type **Web application**.
   Under **Authorized redirect URIs**, paste the URL from step 3.
5. Paste the client ID into `lib/config.ts`.

The redirect URL changes if the extension ID changes. To keep it fixed, generate a key and
set `key` in `wxt.config.ts`.

## Notes

- Sign-in uses `launchWebAuthFlow`, so it works in Chrome, Edge and Firefox.
- Access lasts one hour and renews silently while you're signed in to Google in the browser.
  If it can't, the popup asks you to connect again.
- The first check only records what's already in your inbox, so old mail is never read out.
- Gmail access is read-only. Email text is spoken locally and never sent anywhere.
- Chrome must be running for Hark to work.
