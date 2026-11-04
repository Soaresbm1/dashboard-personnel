(() => {
  'use strict';
  const origin = 'https://soaresbm1.github.io', channel = 'myabacus-local-v1';
  const allowed = () => window.top === window && location.origin === origin && ['/dashboard-personnel/', '/dashboard-personnel/index.html'].includes(location.pathname);
  if (!allowed()) return;
  let pending = false, lastRequest = 0;
  window.addEventListener('message', async event => {
    const message = event.data;
    if (!allowed() || event.source !== window || event.origin !== origin || !message || Object.keys(message).length !== 3
      || message.channel !== channel || message.type !== 'REQUEST' || typeof message.requestId !== 'string'
      || !/^[\w-]{16,64}$/.test(message.requestId) || pending || Date.now() - lastRequest < 500) return;
    pending = true; lastRequest = Date.now();
    try {
      const result = await chrome.runtime.sendMessage({ type: 'MYABACUS_READ' });
      if (allowed()) window.postMessage({ channel, type: 'RESULT', requestId: message.requestId, result }, origin);
    } catch {
      if (allowed()) window.postMessage({ channel, type: 'RESULT', requestId: message.requestId, result: { ok: false } }, origin);
    } finally { pending = false; }
  });
})();
