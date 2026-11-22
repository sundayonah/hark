import './style.css';
import { disconnect, getSession } from '@/lib/auth';
import { listUnread } from '@/lib/gmail';
import { getSeen, getSettings, saveSettings, setSeen } from '@/lib/settings';
import { stop } from '@/lib/speech';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const viewConnect = $('view-connect');
const viewMain = $('view-main');
const connectBtn = $<HTMLButtonElement>('connect');
const connectError = $('connectError');
const account = $('account');
const status = $('status');
const wave = $('wave');
const enabled = $<HTMLInputElement>('enabled');
const senderInput = $<HTMLInputElement>('senderInput');
const addBtn = $<HTMLButtonElement>('addSender');
const senderList = $<HTMLUListElement>('senders');
const senderEmpty = $('senderEmpty');
const rate = $<HTMLInputElement>('rate');
const rateOut = $<HTMLOutputElement>('rateOut');
const modes = document.querySelectorAll<HTMLInputElement>('input[name="mode"]');

const fmtRate = (n: number) => `${n.toFixed(1)}×`;

/* ---------- views ---------- */

async function render() {
  const session = await getSession();
  const { authed, lastCheck, connectError: failed } = await chrome.storage.local.get([
    'authed',
    'lastCheck',
    'connectError',
  ]);
  const s = await getSettings();

  const connected = !!session && authed !== false;
  viewConnect.classList.toggle('hidden', connected);
  viewMain.classList.toggle('hidden', !connected);
  $('toggleWrap').classList.toggle('hidden', !connected);

  if (!connected) {
    if (failed) showError(failed);
    else if (session && authed === false) {
      showError(`Session expired for ${session.email}. Connect again to keep listening.`);
    }
    return;
  }

  account.textContent = session!.email;
  enabled.checked = s.enabled;
  rate.value = String(s.rate);
  rateOut.textContent = fmtRate(s.rate);
  modes.forEach((m) => (m.checked = m.value === s.mode));
  renderSenders(s.senders);

  if (!s.enabled) status.textContent = 'Paused. Hark won’t read anything.';
  else if (s.senders.length === 0) status.textContent = 'Connected. Add a sender to start.';
  else if (lastCheck) {
    const mins = Math.floor((Date.now() - lastCheck) / 60000);
    status.textContent = `Listening. Checked ${mins < 1 ? 'just now' : `${mins} min ago`}.`;
  } else status.textContent = 'Listening. First check is on its way.';
}

function showError(msg: string) {
  connectError.textContent = msg;
  connectError.classList.remove('hidden');
}

/* ---------- senders ---------- */

function renderSenders(senders: string[]) {
  senderList.replaceChildren(
    ...senders.map((name) => {
      const li = document.createElement('li');
      li.className = 'flex items-center gap-1 rounded-full bg-white py-1 pl-3 pr-1 text-sm shadow-sm ring-1 ring-line';
      const label = document.createElement('span');
      label.textContent = name;
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.setAttribute('aria-label', `Remove ${name}`);
      rm.className = 'flex h-5 w-5 items-center justify-center rounded-full text-sage hover:bg-line hover:text-pine focus-visible:outline-2 focus-visible:outline-glow';
      rm.textContent = '×';
      rm.addEventListener('click', () => removeSender(name));
      li.append(label, rm);
      return li;
    }),
  );
  senderEmpty.classList.toggle('hidden', senders.length > 0);
}

function normalize(raw: string): string {
  return raw.trim().toLowerCase().replace(/^from:/, '').replace(/^@/, '');
}

async function addSender() {
  const value = normalize(senderInput.value);
  if (!value) return;
  const { senders } = await getSettings();
  if (!senders.includes(value)) {
    addBtn.disabled = true;
    try {
      // Mark this sender's current unread mail as seen so it isn't read out.
      const seen = await getSeen();
      if (seen !== null) {
        const ids = await listUnread([value]);
        await setSeen([...seen, ...ids]);
      }
    } catch (err) {
      console.error('[Hark] baseline failed', err);
    }
    await saveSettings({ senders: [...senders, value] });
    addBtn.disabled = false;
    chrome.runtime.sendMessage({ type: 'check' });
  }
  senderInput.value = '';
  render();
}

async function removeSender(name: string) {
  const { senders } = await getSettings();
  await saveSettings({ senders: senders.filter((s) => s !== name) });
  render();
}

addBtn.addEventListener('click', addSender);
senderInput.addEventListener('keydown', (e) => e.key === 'Enter' && addSender());

/* ---------- account ---------- */

function runConnect() {
  connectError.classList.add('hidden');
  connectBtn.disabled = true;
  connectBtn.textContent = 'Waiting for Google…';
  // Sign-in runs in the background script, because this popup closes when Google's window opens.
  chrome.runtime.sendMessage({ type: 'connect' });
}

connectBtn.addEventListener('click', runConnect);
$('switch').addEventListener('click', runConnect);
$('disconnect').addEventListener('click', async () => {
  await disconnect();
  render();
});

/* ---------- settings ---------- */

enabled.addEventListener('change', async () => {
  await saveSettings({ enabled: enabled.checked });
  if (!enabled.checked) stop();
  else chrome.runtime.sendMessage({ type: 'check' });
  render();
});

rate.addEventListener('input', () => (rateOut.textContent = fmtRate(Number(rate.value))));
rate.addEventListener('change', () => saveSettings({ rate: Number(rate.value) }));
modes.forEach((m) => m.addEventListener('change', () => saveSettings({ mode: m.value as 'short' | 'full' })));
$('test').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'test' }));

chrome.storage.onChanged.addListener((changes) => {
  if (changes.speaking) wave.classList.toggle('speaking', !!changes.speaking.newValue);
  if (changes.connectDone) {
    connectBtn.disabled = false;
    connectBtn.textContent = 'Connect Gmail';
  }
  if (changes.lastCheck || changes.authed || changes.session || changes.connectDone) render();
});

chrome.storage.local.get('speaking').then(({ speaking }) => wave.classList.toggle('speaking', !!speaking));
render();