export function speak(text: string, rate: number): void {
  chrome.tts.speak(text.slice(0, 5000), {
    rate,
    enqueue: true,
    onEvent: (e) => {
      if (e.type === 'start') chrome.storage.local.set({ speaking: true });
      if (['end', 'interrupted', 'cancelled', 'error'].includes(e.type)) {
        chrome.storage.local.set({ speaking: false });
      }
    },
  });
}

export function stop(): void {
  chrome.tts.stop();
  chrome.storage.local.set({ speaking: false });
}
