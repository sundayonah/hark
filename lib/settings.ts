export interface Settings {
  enabled: boolean;
  senders: string[]; // domains, addresses or names, e.g. "mercor.com"
  rate: number; // speech speed, 0.7 – 1.6
  mode: 'short' | 'full';
}

export const DEFAULTS: Settings = {
  enabled: true,
  senders: [],
  rate: 1,
  mode: 'short',
};

export async function getSettings(): Promise<Settings> {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULTS, ...(settings ?? {}) };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

/** IDs of messages already handled. `null` means first run (no baseline yet). */
export async function getSeen(): Promise<string[] | null> {
  const { seen } = await chrome.storage.local.get('seen');
  return Array.isArray(seen) ? seen : null;
}

export async function setSeen(ids: string[]): Promise<void> {
  await chrome.storage.local.set({ seen: ids.slice(-200) });
}
