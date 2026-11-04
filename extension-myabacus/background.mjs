import { SESSION_KEY, validateRequest, transition } from './protocol.mjs';

// One queue includes reads and writes, so delayed storage cannot reorder documents.
export function createMessageHandler({ extensionId, storage, now = Date.now, ready = Promise.resolve() }) {
  let tail = Promise.resolve();
  return (message, sender) => {
    const result = tail.then(async () => {
      await ready;
      const at = now();
      if (!Number.isSafeInteger(at) || at < 0) return { ok: false, error: 'unavailable' };
      const request = validateRequest(message, sender, { extensionId, now: at });
      if (!request.ok) return request;
      const saved = await storage.get(SESSION_KEY);
      const { state, response } = transition(saved?.[SESSION_KEY], request, at);
      if (state) await storage.set({ [SESSION_KEY]: state });
      else await storage.remove(SESSION_KEY);
      return response;
    });
    tail = result.catch(() => {});
    return result.catch(() => ({ ok: false, error: 'unavailable' }));
  };
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage && chrome.storage?.session) {
  const ready = chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  // Preserve a rejected setup result for fail-closed handling without an unhandled rejection.
  ready.catch(() => {});
  const handle = createMessageHandler({ extensionId: chrome.runtime.id, storage: chrome.storage.session, ready });
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handle(message, sender).then(sendResponse);
    return true;
  });
}
