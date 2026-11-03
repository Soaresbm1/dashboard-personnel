import { createAutoRefresh } from './auto-refresh.mjs';

// The read-only overview does not read or modify existing personal browser data.
function updateDashboardDate() {
  const element = document.querySelector('#top-date');
  const date = new Date();
  element.textContent = new Intl.DateTimeFormat('fr-CH', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  }).format(date);
  element.dateTime = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function showOverview() {
  if (location.hash && !['#overview', '#main'].includes(location.hash)) history.replaceState(null, '', `${location.pathname}${location.search}#overview`);
}
updateDashboardDate();
const dateRefresh = createAutoRefresh({ document, window, refresh: updateDashboardDate, canRefresh: () => true });
dateRefresh.start();
showOverview();
window.addEventListener('hashchange', showOverview);
document.addEventListener('visibilitychange', () => { if (!document.hidden) updateDashboardDate(); });
document.addEventListener('click', event => {
  const menu = document.querySelector('.connection-menu');
  if (menu.open && !menu.contains(event.target) && !event.target.closest('dialog')) menu.open = false;
});
document.addEventListener('keydown', event => {
  const menu = document.querySelector('.connection-menu');
  if (event.key === 'Escape' && menu.open && !document.querySelector('dialog[open]')) { menu.open = false; menu.querySelector('summary').focus(); }
});
