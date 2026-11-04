(() => {
  'use strict';
  const origin = 'https://abaprod.isp-spi.ch', root = '/portal/myabacus/';
  if (window.top !== window || location.origin !== origin || ![root, `${root}welcome`, `${root}welcome/`, `${root}proj_inandout`, `${root}proj_inandout/`].includes(location.pathname)) return;
  const reader = globalThis.MyAbacusLocalReader;
  let managed = false, touched = false, stopped = false, navigating = false, captured = false, running = false, epoch = 0;
  let candidate = '', candidateAt = 0, timer = null, firstInvalid = 0, invalidReason = '';
  const send = message => chrome.runtime.sendMessage(message).catch(() => null);
  const stop = () => { stopped = true; epoch++; if (timer !== null) clearInterval(timer); timer = null; };
  async function release() {
    touched = true;
    if (!managed) return;
    stop(); managed = false;
    await send({ type: 'MYABACUS_RELEASE' });
  }
  // Observe only the fact of interaction, never keys, input values or targets.
  document.addEventListener('pointerdown', release, { capture: true, passive: true });
  document.addEventListener('keydown', release, { capture: true });
  async function failure(reason) {
    stop();
    if (managed) await send({ type: 'MYABACUS_FAILURE', reason });
  }
  async function scan() {
    if (!managed || stopped || running) return;
    running = true; const generation = epoch;
    try {
      const path = location.pathname.replace(/\/$/, '');
      if (path !== `${root}proj_inandout`) {
        const target = reader.personalNavigation(document);
        if (target.state === 'unavailable') { await failure('account'); return; }
        if (target.state === 'ready') {
          if (touched || stopped || generation !== epoch) return;
          const url = new URL(target.url);
          if (url.origin !== origin || url.username || url.password || url.href.length > 2048
            || url.pathname.replace(/\/$/, '') !== `${root}proj_inandout`) { await failure('context'); return; }
          navigating = true; stop(); location.replace(target.url);
        }
        return;
      }
      const result = reader.parse(reader.collect(document)), now = Date.now();
      if (result.state !== 'ready') {
        candidate = ''; candidateAt = 0;
        const reason = ['account', 'context', 'date', 'layout', 'number'].includes(result.reason) ? result.reason : 'exception';
        if (invalidReason !== reason) { invalidReason = reason; firstInvalid = now; }
        // Allow hydration to finish before classifying an incomplete initial frame.
        if (now - firstInvalid >= 12000) await failure(reason);
        return;
      }
      invalidReason = ''; firstInvalid = 0;
      const signature = JSON.stringify(result.snapshot);
      if (signature !== candidate) { candidate = signature; candidateAt = now; return; }
      if (now - candidateAt < 1000 || touched || stopped || generation !== epoch) return;
      const response = await send({ type: 'MYABACUS_PUBLISH', snapshot: result.snapshot });
      if (touched || stopped || generation !== epoch) return;
      if (response?.ok && response.state === 'captured') {
        captured = true; stop();
        // Storage precedes this acknowledgement; only the worker owns tab closure.
        await send({ type: 'MYABACUS_DONE' });
      } else await failure('exception');
    } catch { if (!stopped) await failure('exception'); }
    finally { running = false; }
  }
  window.addEventListener('pagehide', () => {
    const clear = managed && !navigating && !captured && !touched;
    stop(); if (clear) void send({ type: 'MYABACUS_CLEAR' });
  });
  void send({ type: 'MYABACUS_HELLO' }).then(response => {
    if (!response?.ok || !response.managed || stopped) return;
    managed = true;
    if (touched) { void release(); return; }
    timer = setInterval(scan, 1000); void scan();
  });
})();
