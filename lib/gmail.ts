import { getToken } from './auth';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

async function api<T>(path: string, retry = true): Promise<T> {
  const token = await getToken();
  if (!token) throw new Error('Not connected');
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401 && retry) {
    await getToken(true);
    return api<T>(path, false);
  }
  if (!res.ok) throw new Error(`Gmail API ${res.status}`);
  return res.json() as Promise<T>;
}

/** Unread message IDs from any of the senders, newest first. */
export async function listUnread(senders: string[]): Promise<string[]> {
  const from = senders.map((s) => `from:${s}`).join(' OR ');
  const q = encodeURIComponent(`(${from}) is:unread newer_than:2d`);
  const data = await api<{ messages?: { id: string }[] }>(`/messages?q=${q}&maxResults=10`);
  return (data.messages ?? []).map((m) => m.id);
}

export interface Email {
  id: string;
  fromName: string;
  subject: string;
  body: string;
}

export async function getEmail(id: string): Promise<Email> {
  const msg = await api<any>(`/messages/${id}?format=full`);
  const headers: { name: string; value: string }[] = msg.payload?.headers ?? [];
  const h = (n: string) => headers.find((x) => x.name.toLowerCase() === n)?.value ?? '';

  const from = h('from');
  const fromName = from.match(/^"?([^"<]+?)"?\s*</)?.[1]?.trim() || from.replace(/<.*>/, '').trim() || 'unknown sender';

  return {
    id,
    fromName,
    subject: h('subject') || 'no subject',
    body: extractBody(msg.payload),
  };
}

function decode(data: string): string {
  const bin = atob(data.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

function findPart(part: any, mime: string): string | null {
  if (!part) return null;
  if (part.mimeType === mime && part.body?.data) return decode(part.body.data);
  for (const p of part.parts ?? []) {
    const found = findPart(p, mime);
    if (found) return found;
  }
  return null;
}

function extractBody(payload: any): string {
  const plain = findPart(payload, 'text/plain');
  if (plain) return clean(plain);
  const html = findPart(payload, 'text/html');
  return html ? clean(stripHtml(html)) : '';
}

function stripHtml(html: string): string {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"');
}

/** Make an email pleasant to listen to: drop links, quoted replies and footers. */
function clean(text: string): string {
  return text
    .split(/\n(?:On .+ wrote:|-{2,}\s*Original Message|Unsubscribe|You received this email)/i)[0]
    .replace(/^>.*$/gm, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '. ')
    .replace(/\s*\n\s*/g, ' ')
    .trim();
}
