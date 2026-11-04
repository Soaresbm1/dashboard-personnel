import { getNotificationCenter } from './notifications-core.mjs';

export function initializeNotifications({ document: doc = globalThis.document, window: win = globalThis.window } = {}) {
  const get = id => doc.getElementById(id);
  const trigger = get('notifications-open'), dialog = get('notifications-dialog');
  if (!trigger || !dialog) return null;
  const center = getNotificationCenter(doc), list = get('notifications-items'), close = get('notifications-close');
  const date = new Intl.DateTimeFormat('fr-CH', { timeZone: 'Europe/Zurich', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  let signature = '', disposed = false;
  const make = (tag, className, text) => {
    const node = doc.createElement(tag); if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  function render(snapshot) {
    if (disposed) return;
    const count = snapshot.unseenCount;
    get('notifications-count').textContent = String(count); get('notifications-count').hidden = count === 0;
    trigger.setAttribute('aria-label', `Notifications, ${count} non vue${count === 1 ? '' : 's'}`);
    get('notifications-summary').textContent = snapshot.items.length ? `${count} non vue${count === 1 ? '' : 's'} · ${snapshot.items.length} notification${snapshot.items.length === 1 ? '' : 's'}` : 'Aucune notification pour le moment';
    get('notifications-mark-all').disabled = count === 0;
    const unavailable = Object.values(snapshot.sources).some(source => source.stale);
    const ready = Object.values(snapshot.sources).filter(source => source.ready).length;
    const availability = ready === 3 ? 'Mails, tâches/tickets et actualités suivis. ' : ready ? 'Certaines sources ne sont pas encore disponibles. ' : 'Les sources Microsoft ne sont pas encore connectées. ';
    get('notifications-note').textContent = `${availability}${unavailable ? 'Une source ne peut pas être actualisée. ' : ''}${snapshot.limited ? 'Aperçu limité aux dernières notifications. ' : ''}Les mails non lus chargés et les nouveautés détectées depuis l’ouverture de cette page.`;
    const nextSignature = JSON.stringify({ items: snapshot.items, sources: snapshot.sources });
    if (signature === nextSignature) return;
    signature = nextSignature;
    const active = doc.activeElement, focusedId = active?.dataset?.notificationId, focusedAction = active?.dataset?.notificationAction;
    const focusedControls = new Map();
    if (!snapshot.items.length) {
      const empty = make('p', 'notifications-empty', ready === 3 ? 'Aucune nouveauté détectée. Les nouveaux mails, changements de tâches ou tickets et publications apparaîtront ici.'
        : ready ? 'Les nouveautés des services connectés apparaîtront ici.' : 'Utilisez Connexions pour connecter les services Microsoft et suivre vos nouveautés.');
      list.replaceChildren(empty);
      if (dialog.open && focusedId) close.focus();
      return;
    }
    const rows = snapshot.items.map(item => {
      const row = make('article', 'notification-item'); row.dataset.seen = String(item.seen);
      const heading = make('div', 'notification-heading');
      heading.append(make('span', 'notification-label', item.label));
      const time = make('time', 'notification-date', date.format(new Date(item.eventAt)));
      time.dateTime = new Date(item.eventAt).toISOString();
      time.title = `${item.source === 'mail' ? 'Reçu' : item.source === 'news' ? 'Publié' : 'Détecté'} le ${date.format(new Date(item.eventAt))}`;
      heading.append(time);
      const body = make('div', 'notification-body');
      const title = make(item.url ? 'a' : 'strong', 'notification-title', item.title);
      if (item.url) {
        title.href = item.url; title.target = '_blank'; title.rel = 'noopener noreferrer'; title.referrerPolicy = 'no-referrer';
        title.setAttribute('aria-label', `${item.title} — ouvrir ${item.source === 'mail' ? 'dans Outlook' : 'dans l’intranet'}`);
        title.dataset.notificationId = item.id; title.dataset.notificationAction = 'open';
        title.addEventListener('click', () => center.markSeen(item.id));
      }
      body.append(title);
      if (item.detail) body.append(make('p', 'notification-detail', item.detail));
      if (item.stale) body.append(make('p', 'notification-stale', 'Dernières données · source à actualiser'));
      const seen = make('button', 'notification-seen', item.seen ? 'Vue' : 'Marquer comme vue');
      seen.type = 'button'; seen.disabled = item.seen;
      seen.setAttribute('aria-label', `${item.seen ? 'Notification vue' : 'Marquer comme vue'} : ${item.title}`);
      seen.dataset.notificationId = item.id; seen.dataset.notificationAction = 'seen';
      seen.addEventListener('click', () => center.markSeen(item.id));
      row.append(heading, body, seen);
      focusedControls.set(item.id, { open: item.url ? title : null, seen });
      return row;
    });
    list.replaceChildren(...rows);
    if (dialog.open && focusedId) {
      const controls = focusedControls.get(focusedId);
      const node = focusedAction === 'open' ? controls?.open : controls?.seen?.disabled ? controls.open : controls?.seen;
      (node || close).focus();
    }
  }
  const unsubscribe = center.subscribe(render);
  const open = () => { render(center.getSnapshot()); dialog.showModal(); close.focus(); };
  const shut = () => dialog.close();
  const markAll = () => { center.markAllSeen(); close.focus(); };
  const restore = () => trigger.focus();
  trigger.addEventListener('click', open); close.addEventListener('click', shut);
  get('notifications-mark-all').addEventListener('click', markAll); dialog.addEventListener('close', restore);
  const dispose = () => {
    disposed = true; unsubscribe(); trigger.removeEventListener('click', open); close.removeEventListener('click', shut);
    get('notifications-mark-all').removeEventListener('click', markAll); dialog.removeEventListener('close', restore);
  };
  const pagehide = event => { if (!event.persisted) { dispose(); win.removeEventListener?.('pagehide', pagehide); } };
  win.addEventListener?.('pagehide', pagehide);
  return { dispose, center };
}

if (typeof document !== 'undefined') initializeNotifications();
