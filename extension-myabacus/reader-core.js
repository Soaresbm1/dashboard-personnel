// Isolated-world reader. Only rendered DOM is inspected; no application stores or credentials.
(() => {
  'use strict';
  const clean = value => String(value || '').normalize('NFKC').replace(/[\u2019\u2018]/g, "'").replace(/\s+/g, ' ').trim();
  const owner = 'Bernardo Miguel Soares (BMS)';
  function within(element, ancestor) {
    if (!ancestor) return false;
    for (let p = element; p; p = p.parentElement || p.getRootNode?.().host) if (p === ancestor) return true;
    return false;
  }
  function today(now = Date.now()) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(now));
    const part = type => parts.find(p => p.type === type).value;
    return `${part('year')}-${part('month')}-${part('day')}`;
  }
  function decimal(text, hours = false) {
    let raw = clean(text).replace(/\u2212/g, '-');
    if (hours) {
      if (!/\s(?:Hrs|h)$/.test(raw)) return null;
      raw = raw.replace(/\s(?:Hrs|h)$/, '');
    }
    if (!/^[+-]?(?:\d+|\d{1,3}(?:[ '\u2019]\d{3})+)(?:,\d{1,2})?$/.test(raw)) return null;
    const number = Number(raw.replace(/[ '\u2019]/g, '').replace(',', '.'));
    return Number.isFinite(number) && Math.abs(number) <= (hours ? 10000 : 3660) ? (Object.is(number, -0) ? 0 : number) : null;
  }
  function parse(view, now = Date.now()) {
    const invalid = reason => ({ state: 'unavailable', reason, snapshot: null });
    if (!view || clean(view.accountName) !== owner) return invalid('account');
    if (!view.personalContext || clean(view.heading) !== 'In & Out' || view.employeeSelector) return invalid('context');
    const match = clean(view.dateText).match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    const sourceDate = match ? `${match[3]}-${match[2]}-${match[1]}` : '';
    if (sourceDate !== today(now)) return invalid('date');
    const balances = view.balanceRows, vacations = view.vacationRows;
    if (!Array.isArray(balances) || balances.length !== 3 || !Array.isArray(vacations) || vacations.length !== 4) return invalid('layout');
    if (balances.map(r => clean(r.label)).join('|') !== 'Heures supplémentaires|Temps suppl.|Total') return invalid('layout');
    const labels = vacations.map(r => clean(r.label));
    if (labels[0] !== 'Solde à ce jour' || labels[1] !== 'Equivalent en jours'
      || labels[2] !== "Solde disponible jusqu'au 31.12" || labels[3] !== 'Equivalent en jours') return invalid('layout');
    const timeBalanceHours = decimal(balances[2].value, true), vacationRemainingDays = decimal(vacations[1].value);
    const vacationAvailableDays = decimal(vacations[3].value);
    if (timeBalanceHours === null || vacationRemainingDays === null || vacationAvailableDays === null) return invalid('number');
    return { state: 'ready', snapshot: { schemaVersion: 1, sourceDate, timeBalanceHours, vacationRemainingDays, vacationAvailableDays } };
  }
  function collect(doc, { openShadowRoot = element => element.shadowRoot } = {}) {
    const roots = [doc], seen = new Set(roots);
    for (let index = 0; index < roots.length && roots.length <= 500; index++) {
      for (const element of roots[index].querySelectorAll('*')) {
        let root = null;
        try { if (element instanceof doc.defaultView.HTMLElement) root = openShadowRoot(element); } catch { /* Some custom elements do not expose a root. */ }
        if (root && !seen.has(root)) { seen.add(root); roots.push(root); }
      }
    }
    if (roots.length > 500) return null;
    const visible = element => {
      if (!element || ![...element.getClientRects()].some(rect => rect.width > 0 && rect.height > 0)) return false;
      for (let p = element; p; p = p.parentElement || p.getRootNode?.().host) {
        if (p.hidden || p.hasAttribute?.('inert') || p.getAttribute?.('aria-hidden') === 'true') return false;
        const style = doc.defaultView.getComputedStyle(p);
        if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return false;
      }
      return true;
    };
    const all = selector => roots.flatMap(root => [...root.querySelectorAll(selector)]).filter(visible);
    const one = values => values.length === 1 ? values[0] : null;
    const heading = one(all('h1').filter(e => clean(e.textContent) === 'In & Out'));
    const namedAvatars = all('[role="img"][aria-label]').filter(e => clean(e.getAttribute('aria-label')) === owner);
    const account = one(namedAvatars) || one(all('img[alt]').filter(e => clean(e.getAttribute('alt')) === owner));
    const picker = one(all('vaadin-date-picker[movie-id="dateField"]'));
    const dateInput = picker?.querySelector('input[role="combobox"]');
    const personalLinks = all('a[href]').filter(a => {
      try {
        const target = new URL(a.getAttribute('href'), doc.location.href);
        return target.origin === doc.location.origin && target.pathname.replace(/\/$/, '') === '/portal/myabacus/proj_inandout'
          && target.search === doc.location.search && clean(a.textContent).includes('In & Out');
      } catch { return false; }
    });
    const rows = title => {
      const label = one(all('h2').filter(e => clean(e.textContent) === title));
      const content = label?.closest('.va-grouping-panel')?.querySelector('.va-grouping-panel-content');
      if (!content || !visible(content)) return [];
      return [...content.querySelectorAll('vaadin-horizontal-layout')].filter(visible).map(row => {
        const cells = [...row.querySelectorAll('.va-label-text')].filter(visible);
        return cells.length === 2 ? { label: clean(cells[0].textContent), value: clean(cells[1].textContent) } : null;
      }).filter(Boolean);
    };
    return { accountName: account?.getAttribute('aria-label') || account?.getAttribute('alt'), heading: heading?.textContent, dateText: dateInput?.value,
      personalContext: !!heading && personalLinks.length === 1,
      // This personal view currently has only its date picker. Any other selector
      // makes the employee context ambiguous, whatever its language or label.
      employeeSelector: all('[role="combobox"],vaadin-combo-box,vaadin-select').some(e => !within(e, picker)),
      balanceRows: rows('Solde'), vacationRows: rows('Solde vacances en jours') };
  }
  globalThis.MyAbacusLocalReader = Object.freeze({ clean, today, decimal, parse, collect, within });
})();
