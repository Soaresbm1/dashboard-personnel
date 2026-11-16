export const ANF_TEAMS = Object.freeze([
  { id: '34107', clubId: '919', label: 'Le Locle · A', name: 'FC Le Locle · Juniors A', owner: 'FC Le Locle', calendarName: 'FC Le Locle - Juniors A', league: 'Juniors A' },
  { id: '74009', clubId: '902', label: 'Le Parc · Futsal', name: 'FC Le Parc · Swiss Futsal Premier League', owner: 'FC Le Parc', calendarName: 'FC Le Parc - Swiss Futsal Premier League', league: 'Swiss Futsal Premier League' },
  { id: '68914', clubId: '902', label: 'Le Parc 2 · Futsal', name: 'FC Le Parc 2 · 1ère ligue (Futsal)', owner: 'FC Le Parc 2', calendarName: 'FC Le Parc - 1ère ligue (Futsal) 2', league: '1ère ligue (Futsal)' }
].map(team => Object.freeze({ ...team, sourceUrl: `https://matchcenter-anf.football.ch/default.aspx?a=pt&lng=2&oid=15&t=${team.id}&v=${team.clubId}` })));
export function anfTeam(id = '34107') {
  const team = ANF_TEAMS.find(team => team.id === id);
  if (!team) throw new Error('Unknown ANF team');
  return team;
}
const key = value => typeof value === 'string' ? value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim() : '';
export function isAnfTeamName(value, teamId = '34107') {
  const team = anfTeam(teamId);
  const name = teamId === '34107' ? key(value).replace(/\s*\(jun\.?\s*a\)$/, '').trim() : key(value);
  const aliases = teamId === '74009' ? ['FC Le Parc', 'FC Le Parc (SFPL)']
    : teamId === '68914' ? ['FC Le Parc 2', 'FC Le Parc 2 (1 L Futsal)'] : [team.owner];
  return aliases.some(alias => name === key(alias));
}
export const anfCacheKey = (teamId = '34107') => teamId === '34107' ? 'dashboard.lelocle-juniors-a.v1' : `dashboard.anf-team.${anfTeam(teamId).id}.v1`;
