import { connect, getToken } from '@/lib/auth';
import { getEmail, listUnread } from '@/lib/gmail';
import { getSeen, getSettings, setSeen } from '@/lib/settings';
import { speak } from '@/lib/speech';

const ALARM = 'hark-poll';
const SHORT_LIMIT = 500;
const FULL_LIMIT = 4000;

let polling = false;

async function poll() {
  if (polling) return;
  polling = true;
  try {
    const s = await getSettings();
    if (!s.enabled || s.senders.length === 0) return;
    if (!(await getToken())) return;

    const ids = await listUnread(s.senders); // newest first
    const seen = await getSeen();

    // First run: remember what is already in the inbox, don't read it all out.
    if (seen === null) {
      await setSeen(ids);
      return;
    }

    const fresh = ids.filter((id) => !seen.includes(id)).reverse(); // oldest first
    for (const id of fresh) {
      const mail = await getEmail(id);
      const limit = s.mode === 'full' ? FULL_LIMIT : SHORT_LIMIT;
      const body = mail.body.length > limit ? mail.body.slice(0, limit) + '…' : mail.body;
      speak(`New email from ${mail.fromName}. Subject: ${mail.subject}. ${body}`, s.rate);
      seen.push(id);
      await setSeen(seen);
    }
  } catch (err) {
    console.error('[Hark] poll failed', err);
  } finally {
    await chrome.storage.local.set({ lastCheck: Date.now() });
    polling = false;
  }
}

export default defineBackground(() => {
  chrome.alarms.create(ALARM, { delayInMinutes: 0.1, periodInMinutes: 1 });
  chrome.alarms.onAlarm.addListener((a) => a.name === ALARM && poll());
  chrome.runtime.onStartup.addListener(() => poll());

  chrome.runtime.onMessage.addListener(async (msg) => {
    if (msg?.type === 'check') poll();

    if (msg?.type === 'connect') {
      // Runs here, not in the popup: the popup closes as soon as Google's window opens.
      await chrome.storage.local.set({ connectError: '' });
      try {
        const email = await connect();
        await chrome.storage.local.set({
          connectError: email ? '' : 'Sign-in was cancelled. Click Connect Gmail to try again.',
        });
        if (email) poll();
      } catch (err) {
        await chrome.storage.local.set({ connectError: (err as Error).message });
      }
      await chrome.storage.local.set({ connectDone: Date.now() });
    }

    if (msg?.type === 'test') {
      const s = await getSettings();
      speak('New email. Subject: Your next project is ready. This is how Hark will sound.', s.rate);
    }
  });
});