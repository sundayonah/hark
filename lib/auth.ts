import { GOOGLE_CLIENT_ID } from './config';

const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

export interface Session {
  token: string;
  expiresAt: number;
  email: string;
}

function authUrl(prompt: string, loginHint?: string): string {
  const p = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    response_type: 'token',
    redirect_uri: chrome.identity.getRedirectURL(),
    scope: SCOPE,
    prompt,
  });
  if (loginHint) p.set('login_hint', loginHint);
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

async function runFlow(url: string, interactive: boolean) {
  try {
    const redirect = await chrome.identity.launchWebAuthFlow({ url, interactive });
    if (!redirect) return null;
    const params = new URLSearchParams(new URL(redirect).hash.slice(1));
    const token = params.get('access_token');
    if (!token) return null;
    return { token, expiresAt: Date.now() + Number(params.get('expires_in') ?? 3600) * 1000 };
  } catch {
    return null;
  }
}

async function fetchEmail(token: string): Promise<string> {
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error('Could not read Gmail profile');
  return (await res.json()).emailAddress as string;
}

export async function getSession(): Promise<Session | null> {
  const { session } = await chrome.storage.local.get('session');
  return session ?? null;
}

/** Opens Google's account picker. Resolves to the connected email, or null if cancelled. */
export async function connect(): Promise<string | null> {
  if (GOOGLE_CLIENT_ID.startsWith('YOUR_')) {
    throw new Error('Add your Google client ID in lib/config.ts first.');
  }
  const result = await runFlow(authUrl('select_account'), true);
  if (!result) return null;

  const email = await fetchEmail(result.token);
  const previous = await getSession();
  if (previous && previous.email !== email) await chrome.storage.local.remove('seen');

  await chrome.storage.local.set({ session: { ...result, email }, authed: true });
  return email;
}

let refreshing: Promise<string | null> | null = null;

async function refresh(email: string): Promise<string | null> {
  const result = await runFlow(authUrl('none', email), false);
  if (!result) {
    await chrome.storage.local.set({ authed: false });
    return null;
  }
  await chrome.storage.local.set({ session: { ...result, email }, authed: true });
  return result.token;
}

/** A valid access token, renewed silently when it has expired. */
export async function getToken(forceRefresh = false): Promise<string | null> {
  const session = await getSession();
  if (!session) return null;
  if (!forceRefresh && session.expiresAt - Date.now() > 60_000) return session.token;
  refreshing ??= refresh(session.email).finally(() => (refreshing = null));
  return refreshing;
}

export async function disconnect(): Promise<void> {
  const session = await getSession();
  if (session) {
    fetch(`https://oauth2.googleapis.com/revoke?token=${session.token}`, { method: 'POST' }).catch(() => {});
  }
  await chrome.storage.local.remove(['session', 'seen', 'lastCheck', 'speaking']);
  await chrome.storage.local.set({ authed: false });
}
