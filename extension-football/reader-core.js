(() => {
  'use strict';
  const TEAMS = Object.freeze([
    { id: '34107', clubId: '919', label: 'FC Le Locle · Juniors A', category: 'Juniors A', owners: ['FC Le Locle', 'FC Le Locle (Jun.A)'] },
    { id: '74009', clubId: '902', label: 'FC Le Parc · SFPL', category: 'Swiss Futsal Premier League', owners: ['FC Le Parc', 'FC Le Parc (SFPL)'] },
    { id: '68914', clubId: '902', label: 'FC Le Parc 2 · Futsal', category: '1ère ligue (Futsal) 2', owners: ['FC Le Parc 2', 'FC Le Parc 2 (1 L Futsal)'] }
  ].map(team => Object.freeze({ ...team, owners: Object.freeze(team.owners), sourceUrl: `https://matchcenter-anf.football.ch/default.aspx?a=pt&lng=2&oid=15&t=${team.id}&v=${team.clubId}` })));
  const getTeam = (id = '34107') => TEAMS.find(team => team.id === id) || null;
  const SOURCE_URL = getTeam().sourceUrl;
  const MIN_COMPLETED_AGE_MS = 3 * 60 * 60_000;
  const clean = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  const key = value => clean(value).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
  function teamFromUrl(value) {
    try {
      const url = new URL(value);
      if (url.origin !== 'https://matchcenter-anf.football.ch' || url.pathname !== '/default.aspx' || url.username || url.password || url.hash) return null;
      const team = getTeam(url.searchParams.get('t'));
      if (!team) return null;
      const expected = { a: 'pt', lng: '2', oid: '15', t: team.id, v: team.clubId };
      return [...url.searchParams].length === 5 && Object.entries(expected).every(([name, required]) => url.searchParams.getAll(name).length === 1 && url.searchParams.get(name) === required) ? team : null;
    } catch { return null; }
  }
  function isSourceUrl(value, teamId) { const team = teamFromUrl(value); return !!team && (teamId === undefined || team.id === teamId); }
  function isOwnerName(value, teamId = '34107') {
    return getTeam(teamId)?.owners.some(name => key(name) === key(value)) === true;
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
  function normalizeResults(rows, now = Date.now(), teamId = '34107') {
    const team = getTeam(teamId);
    if (!team || !Number.isFinite(now) || !Array.isArray(rows) || rows.length > 100) throw new Error('invalid_results');
    const results = [], ids = new Set();
    for (const row of rows) {
      if (!row || typeof row.id !== 'string' || !/^\d{1,30}$/.test(row.id) || ids.has(row.id)
          || typeof row.home !== 'string' || !clean(row.home) || row.home.length > 160 || typeof row.away !== 'string' || !clean(row.away) || row.away.length > 160
          || [row.home, row.away].filter(name => isOwnerName(name, teamId)).length !== 1 || typeof row.startsAt !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/.test(row.startsAt)
          || !Number.isFinite(Date.parse(row.startsAt)) || Date.parse(row.startsAt) > now - MIN_COMPLETED_AGE_MS || row.timeConfirmed !== true
          || !Number.isInteger(row.scoreHome) || row.scoreHome < 0 || row.scoreHome > 99 || !Number.isInteger(row.scoreAway) || row.scoreAway < 0 || row.scoreAway > 99
          || typeof row.league !== 'string' || !clean(row.league) || row.league.length > 160 || row.url !== team.sourceUrl) throw new Error('invalid_results');
      results.push({ id: row.id, home: clean(row.home), away: clean(row.away), startsAt: new Date(row.startsAt).toISOString(), timeConfirmed: true,
        scoreHome: row.scoreHome, scoreAway: row.scoreAway, league: clean(row.league), url: team.sourceUrl });
      ids.add(row.id);
    }
    return results.sort((a, b) => Date.parse(b.startsAt) - Date.parse(a.startsAt) || a.id.localeCompare(b.id)).slice(0, 3);
  }
  function matchId(row, team) {
    const anchor = row.querySelector('.telegramm-link a');
    if (anchor) {
      try {
        const url = new URL(anchor.getAttribute('href'), team.sourceUrl), id = url.searchParams.get('tg');
        if (url.origin === 'https://matchcenter-anf.football.ch' && url.pathname === '/default.aspx' && !url.username && !url.password && url.searchParams.get('v') === team.clubId && url.searchParams.get('t') === team.id && /^\d{1,30}$/.test(id || '')) return id;
      } catch { /* The match number below is also an official identifier. */ }
    }
    const number = /N[°o]\s*match\s*(\d{1,30})\b/i.exec(clean(row.textContent));
    if (!number) throw new Error('missing_match_identifier');
    return number[1];
  }
  function readResults(doc, now = Date.now(), teamId) {
    const team = teamFromUrl(doc?.URL || doc?.location?.href);
    if (!team || teamId !== undefined && team.id !== teamId || doc.readyState && doc.readyState !== 'complete') throw new Error('unexpected_match_page');
    const headers = [doc.querySelector('#ddmTeam'), ...doc.querySelectorAll('h3')].filter(Boolean);
    const expectedHeader = key(`Equipe - ${team.category}`).replace(/[–—]/g, '-');
    if (!headers.some(header => key(header.textContent).replace(/[–—]/g, '-') === expectedHeader)) throw new Error('unexpected_match_team');
    const tables = [...doc.querySelectorAll('[id$="_tbResultate"].nisListeRD')];
    const byHeading = tables.filter(table => key(table.previousElementSibling?.querySelector?.('h4')?.textContent) === 'calendrier equipe');
    const populated = tables.filter(table => [...table.children].some(item => item.querySelector?.('.row.spiel')));
    const table = byHeading.length === 1 ? byHeading[0] : populated.length === 1 ? populated[0] : tables.length === 1 ? tables[0] : null;
    if (!table) throw new Error('missing_match_calendar');
    const items = [...table.children].filter(item => item.classList.contains('list-group-item'));
    if (items.length > 2000) throw new Error('oversized_match_calendar');
    let league = team.category, recognized = 0;
    const results = [], seen = new Map();
    for (const item of items) {
      if (item.classList.contains('sppTitel')) { league = clean(item.textContent).slice(0, 160) || team.category; recognized++; continue; }
      const row = item.querySelector('.row.spiel');
      if (!row) continue;
      recognized++;
      const home = clean(row.querySelector('.teamA')?.textContent), away = clean(row.querySelector('.teamB')?.textContent);
      if (!home || !away || home.length > 160 || away.length > 160 || [home, away].filter(name => isOwnerName(name, team.id)).length !== 1) throw new Error('unexpected_match_team');
      const scoreHomeText = clean(row.querySelector('.goals .torA')?.textContent), scoreAwayText = clean(row.querySelector('.goals .torB')?.textContent);
      if (!/^\d{1,2}$/.test(scoreHomeText) || !/^\d{1,2}$/.test(scoreAwayText)) continue;
      if (/\b(?:annule|annulee|renvoye|renvoyee|reporte|reportee|live|en cours|mi-temps|interrompu|interrompue|abandonne|abandonnee|arrete|arretee|non[- ]comptabilise|pas encore joue|non joue)\b/.test(key(row.textContent))) continue;
      const date = row.querySelector('.date'), dateSpan = date?.querySelector('span');
      if (!date || !dateSpan) throw new Error('missing_match_date');
      const remainder = clean(date.textContent.replace(dateSpan.textContent, ''));
      let when;
      try { when = parseSwissDate(dateSpan.textContent, remainder); }
      catch (error) { if (error.message === 'unconfirmed_match_time') continue; throw error; }
      if (Date.parse(when.startsAt) > now - MIN_COMPLETED_AGE_MS) continue;
      const result = { id: matchId(row, team), home, away, ...when, scoreHome: Number(scoreHomeText), scoreAway: Number(scoreAwayText), league, url: team.sourceUrl };
      if (seen.has(result.id)) {
        if (JSON.stringify(seen.get(result.id)) !== JSON.stringify(result)) throw new Error('conflicting_match_result');
        continue;
      }
      seen.set(result.id, result); results.push(result);
    }
    if (items.length && !recognized) throw new Error('unknown_match_calendar');
    return normalizeResults(results, now, team.id);
  }
  globalThis.DashboardFootballReader = Object.freeze({ TEAMS, getTeam, teamFromUrl, SOURCE_URL, MIN_COMPLETED_AGE_MS, isSourceUrl, isOwnerName, parseSwissDate, normalizeResults, readResults });
})();
