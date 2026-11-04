(() => {
  'use strict';
  const origin = 'https://soaresbm1.github.io', channel = 'myabacus-local-v1';
  const allowed = () => window.top === window && location.origin === origin && ['/dashboard-personnel/', '/dashboard-personnel/index.html'].includes(location.pathname);
  if (!allowed()) return;
  let pending = false, lastRequest = 0;
  window.addEventListener('message', async event => {
    const message = event.data;
    if (!allowed() || event.source !== window || event.origin !== origin || !message || Object.keys(message).length !== 3
      || message.channel !== channel || !['REQUEST', 'FORCE', 'STOP'].includes(message.type) || typeof message.requestId !== 'string'
      || !/^[\w-]{16,64}$/.test(message.requestId) || message.type === 'REQUEST' && (pending || Date.now() - lastRequest < 500)) return;
    const control = message.type !== 'REQUEST';
    if (!control) { pending = true; lastRequest = Date.now(); }
    try {
      const type = { REQUEST: 'MYABACUS_READ', FORCE: 'MYABACUS_CAPTURE', STOP: 'MYABACUS_STOP' }[message.type];
      const result = await chrome.runtime.sendMessage({ type });
      if (allowed()) window.postMessage({ channel, type: 'RESULT', requestId: message.requestId, result }, origin);
    } catch {
      if (allowed()) window.postMessage({ channel, type: 'RESULT', requestId: message.requestId, result: { ok: false } }, origin);
    } finally { if (!control) pending = false; }
  });
})();
