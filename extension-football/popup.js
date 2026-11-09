const status = document.getElementById('status'), updated = document.getElementById('updated'), refresh = document.getElementById('refresh');
async function show(type = 'GET_RESULTS') {
  refresh.disabled = true;
  try {
    const value = await chrome.runtime.sendMessage({ type });
    status.textContent = value?.refreshing ? 'Lecture de l’ANF en cours…' : value?.resultsState === 'ready' ? `${value.results.length} résultat(s) disponible(s)${value.resultsCheckFailed ? ' · dernières données conservées' : ''}.` : 'En attente d’une lecture réussie de l’ANF.';
    updated.textContent = value?.resultsCheckedAt ? `Dernier relevé : ${new Intl.DateTimeFormat('fr-CH', { timeZone: 'Europe/Zurich', dateStyle: 'short', timeStyle: 'short' }).format(new Date(value.resultsCheckedAt))}` : '';
  } catch { status.textContent = 'L’extension ne répond pas pour le moment.'; }
  finally { refresh.disabled = false; }
}
refresh.addEventListener('click', () => show('REFRESH_RESULTS'));
void show();
