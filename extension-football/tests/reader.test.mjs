import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
const context = vm.createContext({ URL, Intl, Date });
vm.runInContext(fs.readFileSync(new URL('../reader-core.js', import.meta.url), 'utf8'), context);
const reader = context.DashboardFootballReader;
const NOW = Date.parse('2026-11-09T12:00:00Z');
const plain = value => JSON.parse(JSON.stringify(value));
const result = (id = '1', extra = {}) => ({ id, home: 'FC Le Locle', away: 'Fixture', startsAt: '2026-11-08T15:00:00.000Z', timeConfirmed: true, scoreHome: 0, scoreAway: 2, league: 'Juniors A', url: reader.SOURCE_URL, ...extra });
function element(textContent = '', query = {}, classes = []) { return { textContent, querySelector: selector => query[selector] || null, classList: { contains: value => classes.includes(value) } }; }
function row({ id = '1', home = 'FC Le Locle', away = 'Fixture', date = 'Di 08.11.2026', time = '16:00', homeScore = '0', awayScore = '2', status = '', href } = {}) {
  const dateSpan = element(date), dateNode = element(`${date}${time}`, { span: dateSpan });
  const node = element(`${date} ${time} ${home} ${away} ${homeScore} ${awayScore} ${status} N° match ${id}`, {
    '.date': dateNode, '.teamA': element(home), '.teamB': element(away), '.goals .torA': homeScore === null ? null : element(homeScore), '.goals .torB': awayScore === null ? null : element(awayScore),
    '.telegramm-link a': href ? { getAttribute: () => href } : null
  });
  return element('', { '.row.spiel': node }, ['list-group-item']);
}
function documentFor(items, options = {}) {
  const table = { children: items };
  return { URL: options.url || reader.SOURCE_URL, readyState: options.readyState || 'complete', querySelector: selector => selector === '#ddmTeam' ? element(options.header || 'Equipe - Juniors A') : null,
    querySelectorAll: () => options.tables ?? [table] };
}
test('Only the exact public team calendar URL is eligible regardless of query order', () => {
  assert.equal(reader.isSourceUrl(reader.SOURCE_URL), true);
  assert.equal(reader.isSourceUrl('https://matchcenter-anf.football.ch/default.aspx?v=919&t=34107&oid=15&lng=2&a=pt'), true);
  for (const url of [reader.SOURCE_URL + '#x', reader.SOURCE_URL + '&extra=1', reader.SOURCE_URL + '&t=34107', reader.SOURCE_URL.replace('34107', '34108'), reader.SOURCE_URL.replace('https:', 'http:'), reader.SOURCE_URL.replace('football.ch/', 'football.ch.evil.test/'), reader.SOURCE_URL.replace('https://', 'https://user@')]) assert.equal(reader.isSourceUrl(url), false);
});

test('Each configured team has a fixed club, category and exact owner aliases; selectors cannot cross-bind', () => {
  assert.deepEqual(plain(reader.TEAMS.map(team => team.id)), ['34107', '74009', '68914']);
  for (const team of reader.TEAMS) {
    assert.equal(reader.isSourceUrl(team.sourceUrl, team.id), true);
    assert.equal(reader.teamFromUrl(team.sourceUrl).id, team.id);
    for (const other of reader.TEAMS.filter(other => other.id !== team.id)) {
      assert.equal(reader.isSourceUrl(team.sourceUrl, other.id), false);
      assert.equal(reader.isOwnerName(other.owners[0], team.id), false);
      assert.throws(() => reader.normalizeResults([result('1', { home: other.owners[0], url: team.sourceUrl })], NOW, team.id));
    }
    assert.equal(reader.isSourceUrl(team.sourceUrl.replace(`v=${team.clubId}`, 'v=123')), false);
    assert.equal(reader.isSourceUrl(team.sourceUrl.replace('a=pt', 'a=trr')), false);
  }
  assert.throws(() => reader.normalizeResults([], NOW, 'unknown'));
});

test('Real public DOM captures use h3 and the team calendar after a separate club table; future non-counted 0–0 never becomes a result', () => {
  const fixture = JSON.parse(fs.readFileSync(new URL('fixtures/anf-futsal-public-dom.json', import.meta.url), 'utf8'));
  const capturedAt = Date.parse(fixture.capturedAt);
  for (const team of fixture.teams) {
    const items = team.rows.map(value => value.competitionHeading ? element(value.competitionHeading, {}, ['list-group-item', 'sppTitel'])
      : row({ ...value, id: value.number, homeScore: value.scoreHome, awayScore: value.scoreAway }));
    const clubTable = { children: [] }, calendar = { children: items, previousElementSibling: element('', { h4: element('Calendrier équipe') }) };
    const doc = { URL: team.url, readyState: team.readyState, querySelector: () => null,
      querySelectorAll: selector => selector === 'h3' ? [element(team.heading)] : [clubTable, calendar] };
    const output = plain(reader.readResults(doc, capturedAt, team.teamId));
    assert.deepEqual(output.map(value => value.id), team.teamId === '74009' ? ['4313445', '4310427', '4310422'] : ['4411629', '4408842']);
    assert.ok(output.every(value => value.url === team.url));
    if (team.teamId === '68914') {
      assert.equal(output[0].scoreHome, 1); assert.equal(output[0].scoreAway, 9);
      assert.ok(!reader.readResults(doc, Date.parse('2027-03-01T12:00:00Z'), team.teamId).some(value => value.id === '185620'));
    }
    assert.throws(() => reader.readResults(doc, capturedAt, '34107'));
    const wrongCategory = { ...doc, querySelectorAll: selector => selector === 'h3' ? [element('Equipe - Juniors A')] : [clubTable, calendar] };
    assert.throws(() => reader.readResults(wrongCategory, capturedAt, team.teamId));
  }
});

test('Unidentified ambiguous tables and unrelated team rows cannot clear an existing result sample', () => {
  const team = reader.getTeam('74009'), items = [row({ home: 'FC Le Parc' })];
  const doc = { URL: team.sourceUrl, readyState: 'complete', querySelector: () => null,
    querySelectorAll: selector => selector === 'h3' ? [element(`Equipe - ${team.category}`)] : [{ children: items }, { children: items }] };
  assert.throws(() => reader.readResults(doc, NOW));
  const ownerMismatch = { ...doc, querySelectorAll: selector => selector === 'h3' ? [element(`Equipe - ${team.category}`)] : [{ children: [row({ home: 'FC Le Parc 2' })] }] };
  assert.throws(() => reader.readResults(ownerMismatch, NOW));
});
test('Swiss winter/summer dates convert precisely and unknown, invalid or ambiguous times are rejected', () => {
  assert.equal(reader.parseSwissDate('Di 08.11.2026', '16:00').startsAt, '2026-11-08T15:00:00.000Z');
  assert.equal(reader.parseSwissDate('06.07.2027', '16:00').startsAt, '2027-07-06T14:00:00.000Z');
  for (const [day, time] of [['30.02.2027', '16:00'], ['20.03.2027', '00:00'], ['28.03.2027', '02:30'], ['31.10.2027', '02:30'], ['20.03.2027', 'à fixer']]) assert.throws(() => reader.parseSwissDate(day, time));
});
test('Strict score validation preserves zero, strips extra properties, restricts ownership and sorts only the latest three', () => {
  const rows = ['01', '02', '03', '04'].map((day, index) => result(String(index), { startsAt: `2026-11-${day}T15:00:00Z`, body: 'not stored' }));
  const output = plain(reader.normalizeResults(rows, NOW));
  assert.deepEqual(output.map(x => x.id), ['3', '2', '1']); assert.equal(output[0].scoreHome, 0); assert.ok(!('body' in output[0]));
  for (const extra of [{ scoreHome: '-' }, { scoreAway: null }, { scoreAway: 100 }, { scoreHome: -1 }, { home: 'FC Le Locle II' }, { home: 'FC Le Locle (Jun.B)' }, { url: 'javascript:alert(1)' }, { startsAt: '2026-11-09T11:00:00Z' }]) assert.throws(() => reader.normalizeResults([result('1', extra)], NOW));
  assert.throws(() => reader.normalizeResults([result(), result()], NOW));
});
test('Read-only DOM extraction keeps domicile/away scores and competition labels without interpreting HTML', () => {
  const title = element('coupe Juniors A', {}, ['list-group-item', 'sppTitel']);
  const doc = documentFor([title, row({ id: '10', home: '<img src=x>', away: 'FC Le Locle (Jun.A)', homeScore: '3', awayScore: '1' }), row({ id: '11', date: 'Di 01.11.2026' })]);
  const output = plain(reader.readResults(doc, NOW));
  assert.equal(output.length, 2); assert.equal(output[0].home, '<img src=x>'); assert.equal(output[0].scoreAway, 1); assert.equal(output[0].league, 'coupe Juniors A'); assert.equal(output[0].url, reader.SOURCE_URL);
});
test('Missing scores, dashes, live/cancelled/recent games and provisional midnight are not completed zero results', () => {
  const doc = documentFor([row({ id: '1', homeScore: null }), row({ id: '2', awayScore: '-' }), row({ id: '3', status: 'En cours' }), row({ id: '4', status: 'match renvoyé' }), row({ id: '5', date: 'Lu 09.11.2026', time: '12:00' }), row({ id: '6', time: '00:00' })]);
  assert.deepEqual(plain(reader.readResults(doc, NOW)), []);
});
test('Challenge/missing tables, another team category or partial pages cannot produce a successful empty snapshot', () => {
  for (const doc of [documentFor([], { tables: [] }), documentFor([], { header: 'Equipe - Juniors B' }), documentFor([], { readyState: 'loading' }), documentFor([row({ home: 'FC Le Locle II' })]), documentFor([element('unknown format', {}, ['list-group-item'])])]) assert.throws(() => reader.readResults(doc, NOW));
  assert.deepEqual(plain(reader.readResults(documentFor([]), NOW)), []);
});
test('Identical duplicate match rows are deduplicated, conflicting scores are rejected', () => {
  assert.equal(reader.readResults(documentFor([row(), row()]), NOW).length, 1);
  assert.throws(() => reader.readResults(documentFor([row(), row({ homeScore: '4' })]), NOW));
});
