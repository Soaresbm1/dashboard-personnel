const status = document.getElementById('status'), updated = document.getElementById('updated'), refresh = document.getElementById('refresh'), team = document.getElementById('team');
let generation = 0;
async function show(type = 'GET_RESULTS') {
  const selected = team.value, currentGeneration = ++generation;
  refresh.disabled = true;
  try {
    const value = await chrome.runtime.sendMessage({ type, teamId: selected });
    if (currentGeneration !== generation) return;
    if (value?.teamId !== selected) throw new Error('unexpected_team');
    status.textContent = value?.refreshing ? 'Lecture de l’ANF en cours…' : value?.resultsState === 'ready' ? `${value.results.length} résultat(s) disponible(s)${value.resultsCheckFailed ? ' · dernières données conservées' : ''}.` : 'En attente d’une lecture réussie de l’ANF.';
    updated.textContent = value?.resultsCheckedAt ? `Dernier relevé : ${new Intl.DateTimeFormat('fr-CH', { timeZone: 'Europe/Zurich', dateStyle: 'short', timeStyle: 'short' }).format(new Date(value.resultsCheckedAt))}` : '';
  } catch { if (currentGeneration === generation) { status.textContent = 'L’extension ne répond pas pour le moment.'; updated.textContent = ''; } }
  finally { if (currentGeneration === generation) refresh.disabled = false; }
}
refresh.addEventListener('click', () => show('REFRESH_RESULTS'));
team.addEventListener('change', () => { void chrome.storage.local.set({ dashboardFootballPopupTeam: team.value }); void show(); });
void (async () => {
  try {
    const saved = (await chrome.storage.local.get('dashboardFootballPopupTeam')).dashboardFootballPopupTeam;
    if ([...team.options].some(option => option.value === saved)) team.value = saved;
  } catch { /* The default team remains available if the saved choice cannot be read. */ }
  await show();
})();
