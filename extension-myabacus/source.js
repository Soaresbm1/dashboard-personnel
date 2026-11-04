(() => {
  'use strict';
  if (window.top !== window || location.origin !== 'https://abaprod.isp-spi.ch' || !location.pathname.startsWith('/portal/myabacus/')) return;
  const reader = globalThis.MyAbacusLocalReader;
  let signature = '', lastSent = 0, running = false, stopped = false, generation = 0, diagnostic = '', diagnosticCount = 0;
  const report = (stage, state, reason = '') => {
    const next = `${stage}:${state}:${reason}`;
    if (next === diagnostic || diagnosticCount >= 10) return;
    diagnostic = next; diagnosticCount++;
    console.info('[Dashboard MyAbacus]', { stage, state, reason });
  };
  const send = message => chrome.runtime.sendMessage(message).catch(() => { stopped = true; });
  async function scan() {
    if (running || stopped) return;
    running = true; const epoch = generation;
    try {
      let result = { state: 'unavailable' };
      if (location.pathname.replace(/\/$/, '') === '/portal/myabacus/proj_inandout') {
        const view = reader.collect(document);
        result = reader.parse(view);
      }
      report('parse', result.state, result.reason || '');
      if (result.state !== 'ready') {
        if (signature) { await send({ type: 'MYABACUS_CLEAR' }); signature = ''; }
        return;
      }
      const next = JSON.stringify(result.snapshot), now = Date.now();
      if (next !== signature) {
        const response = await send({ type: 'MYABACUS_PUBLISH', snapshot: result.snapshot });
        if (!response?.ok) report('publish', 'unavailable', ['invalid_sender', 'invalid_snapshot', 'unavailable'].includes(response?.error) ? response.error : 'unavailable');
        if (epoch !== generation || stopped) return;
        if (response?.ok) { signature = next; lastSent = now; }
      } else if (now - lastSent >= 25000) {
        const response = await send({ type: 'MYABACUS_HEARTBEAT' });
        if (epoch !== generation || stopped) return;
        if (response?.state === 'empty' || !response?.ok) signature = '';
        lastSent = now;
      }
    } catch {
      report('collect', 'unavailable', 'exception');
      if (signature) await send({ type: 'MYABACUS_CLEAR' });
      signature = '';
    } finally { running = false; }
  }
  window.addEventListener('pagehide', () => { generation++; stopped = true; signature = ''; void send({ type: 'MYABACUS_CLEAR' }); });
  window.addEventListener('pageshow', () => { generation++; stopped = false; signature = ''; void scan(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void scan(); });
  setInterval(scan, 5000);
  void scan();
})();
