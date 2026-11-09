(() => {
  'use strict';
  const reader = globalThis.DashboardFootballReader;
  if (!reader?.isSourceUrl(location.href) || window.top !== window) return;
  let requestId = null, deadlineAt = 0, observer = null, timer = null, pending = false, done = false, lastCandidate = '', stableAt = 0;
  const startedAt = Date.now();
  const send = message => chrome.runtime.sendMessage(message);
  function stop() { done = true; observer?.disconnect(); clearTimeout(timer); }
  async function attempt() {
    if (done || pending) return;
    pending = true;
    try {
      if (!requestId) {
        const response = await send({ type: 'SOURCE_HELLO' });
        if (response?.capture) { requestId = response.requestId; deadlineAt = response.deadlineAt; }
        else if (Date.now() - startedAt > 20_000) { stop(); return; }
      }
      if (requestId) {
        if (!reader.isSourceUrl(location.href)) { stop(); return; }
        try {
          const results = reader.readResults(document, Date.now());
          const candidate = JSON.stringify(results);
          if (candidate !== lastCandidate) { lastCandidate = candidate; stableAt = Date.now(); }
          // Let any dynamically hydrated score table settle before accepting an empty/partial view.
          if (document.readyState === 'complete' && Date.now() - stableAt >= 1500) {
            await send({ type: 'SOURCE_RESULTS', requestId, results }); stop(); return;
          }
        } catch { /* A challenge, loading table or wrong owner is never an empty result. */ }
        if (Date.now() >= deadlineAt - 1000) { await send({ type: 'SOURCE_FAILED', requestId }); stop(); return; }
      }
    } catch { /* Worker restart/network navigation: retry within the bounded capture lifetime. */ }
    finally {
      pending = false;
      if (!done) { clearTimeout(timer); timer = setTimeout(attempt, 1000); }
    }
  }
  observer = new MutationObserver(() => { if (!pending && !done) { clearTimeout(timer); timer = setTimeout(attempt, 250); } });
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  void attempt();
})();
