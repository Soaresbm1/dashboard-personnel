(() => {
  'use strict';
  const SOURCE_URL = 'https://matchcenter-anf.football.ch/default.aspx?a=pt&lng=2&oid=15&t=34107&v=919';
  const MIN_COMPLETED_AGE_MS = 3 * 60 * 60_000;
  const clean = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  const key = value => clean(value).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
  function isSourceUrl(value) {
    try {
      const url = new URL(value);
      if (url.origin !== 'https://matchcenter-anf.football.ch' || url.pathname !== '/default.aspx' || url.username || url.password || url.hash) return false;
      const expected = { a: 'pt', lng: '2', oid: '15', t: '34107', v: '919' };
      return [...url.searchParams].length === 5 && Object.entries(expected).every(([name, required]) => url.searchParams.getAll(name).length === 1 && url.searchParams.get(name) === required);
    } catch { return false; }
  }
  function isOwnerName(value) {
    return key(value).replace(/\s*\(jun\.?\s*a\)$/, '').trim() === 'fc le locle';
  }
  function parseSwissDate(dayText, timeText) {
    const day = /(?:^|\s)(\d{2})\.(\d{2})\.(\d{4})(?:\s|$)/.exec(clean(dayText));
    const time = /^(\d{2}):(\d{2})$/.exec(clean(timeText));
    if (!day || !time || time[1] + time[2] === '0000') throw new Error('unconfirmed_match_time');
    const [, dd, mm, yyyy] = day, [, hh, minute] = time;
    const date = Date.UTC(+yyyy, +mm - 1, +dd, +hh, +minute), check = new Date(date);
    if (+yyyy < 2000 || +yyyy > 2100 || check.getUTCFullYear() !== +yyyy || check.getUTCMonth() !== +mm - 1 || check.getUTCDate() !== +dd || check.getUTCHours() !== +hh || check.getUTCMinutes() !== +minute) throw new Error('invalid_match_time');
    const formatter = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const candidates = [60, 120].map(offset => date - offset * 60_000).filter(candidate => {
      const local = Object.fromEntries(formatter.formatToParts(new Date(candidate)).map(part => [part.type, part.value]));
      return local.year === yyyy && local.month === mm && local.day === dd && local.hour === hh && local.minute === minute;
    });
    if (candidates.length !== 1) throw new Error('unconfirmed_match_time');
    return { startsAt: new Date(candidates[0]).toISOString(), timeConfirmed: true };
  }
  function normalizeResults(rows, now = Date.now()) {
    if (!Number.isFinite(now) || !Array.isArray(rows) || rows.length > 100) throw new Error('invalid_results');
    const results = [], ids = new Set();
    for (const row of rows) {
      if (!row || typeof row.id !== 'string' || !/^\d{1,30}$/.test(row.id) || ids.has(row.id)
          || typeof row.home !== 'string' || !clean(row.home) || row.home.length > 160 || typeof row.away !== 'string' || !clean(row.away) || row.away.length > 160
          || [row.home, row.away].filter(isOwnerName).length !== 1 || typeof row.startsAt !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/.test(row.startsAt)
          || !Number.isFinite(Date.parse(row.startsAt)) || Date.parse(row.startsAt) > now - MIN_COMPLETED_AGE_MS || row.timeConfirmed !== true
          || !Number.isInteger(row.scoreHome) || row.scoreHome < 0 || row.scoreHome > 99 || !Number.isInteger(row.scoreAway) || row.scoreAway < 0 || row.scoreAway > 99
          || typeof row.league !== 'string' || !clean(row.league) || row.league.length > 160 || row.url !== SOURCE_URL) throw new Error('invalid_results');
      results.push({ id: row.id, home: clean(row.home), away: clean(row.away), startsAt: new Date(row.startsAt).toISOString(), timeConfirmed: true,
        scoreHome: row.scoreHome, scoreAway: row.scoreAway, league: clean(row.league), url: SOURCE_URL });
      ids.add(row.id);
    }
    return results.sort((a, b) => Date.parse(b.startsAt) - Date.parse(a.startsAt) || a.id.localeCompare(b.id)).slice(0, 3);
  }
  function matchId(row) {
    const anchor = row.querySelector('.telegramm-link a');
    if (anchor) {
      try {
        const url = new URL(anchor.getAttribute('href'), SOURCE_URL), id = url.searchParams.get('tg');
        if (url.origin === 'https://matchcenter-anf.football.ch' && url.pathname === '/default.aspx' && !url.username && !url.password && url.searchParams.get('v') === '919' && url.searchParams.get('t') === '34107' && /^\d{1,30}$/.test(id || '')) return id;
      } catch { /* The match number below is also an official identifier. */ }
    }
    const number = /N[°o]\s*match\s*(\d{1,30})\b/i.exec(clean(row.textContent));
    if (!number) throw new Error('missing_match_identifier');
    return number[1];
  }
  function readResults(doc, now = Date.now()) {
    if (!doc || !isSourceUrl(doc.URL || doc.location?.href) || doc.readyState && doc.readyState !== 'complete') throw new Error('unexpected_match_page');
    if (!/\bequipe\s*[-–—]\s*juniors\s+a\b/.test(key(doc.querySelector('#ddmTeam')?.textContent))) throw new Error('unexpected_match_team');
    const tables = doc.querySelectorAll('[id$="_tbResultate"].nisListeRD');
    if (tables.length !== 1) throw new Error('missing_match_calendar');
    const items = [...tables[0].children].filter(item => item.classList.contains('list-group-item'));
    if (items.length > 2000) throw new Error('oversized_match_calendar');
    let league = 'Juniors A', recognized = 0;
    const results = [], seen = new Map();
    for (const item of items) {
      if (item.classList.contains('sppTitel')) { league = clean(item.textContent).slice(0, 160) || 'Juniors A'; recognized++; continue; }
      const row = item.querySelector('.row.spiel');
      if (!row) continue;
      recognized++;
      const home = clean(row.querySelector('.teamA')?.textContent), away = clean(row.querySelector('.teamB')?.textContent);
      if (!home || !away || home.length > 160 || away.length > 160 || [home, away].filter(isOwnerName).length !== 1) throw new Error('unexpected_match_team');
      const scoreHomeText = clean(row.querySelector('.goals .torA')?.textContent), scoreAwayText = clean(row.querySelector('.goals .torB')?.textContent);
      if (!/^\d{1,2}$/.test(scoreHomeText) || !/^\d{1,2}$/.test(scoreAwayText)) continue;
      if (/\b(?:annule|annulee|renvoye|renvoyee|reporte|reportee|live|en cours|mi-temps|interrompu|interrompue|abandonne|abandonnee|arrete|arretee)\b/.test(key(row.textContent))) continue;
      const date = row.querySelector('.date'), dateSpan = date?.querySelector('span');
      if (!date || !dateSpan) throw new Error('missing_match_date');
      const remainder = clean(date.textContent.replace(dateSpan.textContent, ''));
      let when;
      try { when = parseSwissDate(dateSpan.textContent, remainder); }
      catch (error) { if (error.message === 'unconfirmed_match_time') continue; throw error; }
      if (Date.parse(when.startsAt) > now - MIN_COMPLETED_AGE_MS) continue;
      const result = { id: matchId(row), home, away, ...when, scoreHome: Number(scoreHomeText), scoreAway: Number(scoreAwayText), league, url: SOURCE_URL };
      if (seen.has(result.id)) {
        if (JSON.stringify(seen.get(result.id)) !== JSON.stringify(result)) throw new Error('conflicting_match_result');
        continue;
      }
      seen.set(result.id, result); results.push(result);
    }
    if (items.length && !recognized) throw new Error('unknown_match_calendar');
    return normalizeResults(results, now);
  }
  globalThis.DashboardFootballReader = Object.freeze({ SOURCE_URL, MIN_COMPLETED_AGE_MS, isSourceUrl, isOwnerName, parseSwissDate, normalizeResults, readResults });
})();
