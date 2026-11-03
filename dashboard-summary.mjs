import { localDateKey, eventOverlapsDay } from './outlook-core.mjs';
import { summarizeIntranetWork } from './intranet-core.mjs';

// Snapshots belong to this page only; no storage, network or authentication.
const snapshots = new WeakMap();
const available = snapshot => ['ready', 'stale'].includes(snapshot?.status);
const time = date => new Intl.DateTimeFormat('fr-CH', { hour: '2-digit', minute: '2-digit' }).format(date);

export function summarizeAgenda(events, window, now = new Date()) {
  const period = window?.range === 'week' ? 'Cette semaine' : 'Aujourd’hui';
  const rank = event => event.start <= now && event.end > now ? (event.isAllDay ? 1 : 0) : 2;
  const candidates = (events || []).filter(event => event.start instanceof Date && event.end instanceof Date
    && (event.end > now || (+event.start === +event.end && event.start >= now))
    && (!window || eventOverlapsDay(event, window.start, window.end)))
    .sort((a, b) => rank(a) - rank(b) || a.start - b.start
      || Number(a.isAllDay) - Number(b.isAllDay) || a.title.localeCompare(b.title, 'fr'));
  const event = candidates[0];
  if (!event) return { value: 'Aucun à venir', detail: period };
  const day = localDateKey(event.start) === localDateKey(now) ? 'Aujourd’hui'
    : new Intl.DateTimeFormat('fr-CH', { weekday: 'short', day: 'numeric', month: 'short' }).format(event.start);
  const current = event.start <= now && event.end > now;
  const value = event.isAllDay ? 'Toute la journée' : current ? 'En cours' : time(event.start);
  const endDay = localDateKey(event.end) === localDateKey(now) ? '' : `${new Intl.DateTimeFormat('fr-CH', { weekday: 'short', day: 'numeric', month: 'short' }).format(event.end)} `;
  const timing = event.isAllDay ? day : current ? `Jusqu’à ${endDay}${time(event.end)}` : day;
  return { value, detail: `${timing} · ${event.isPrivate ? 'Événement privé' : event.title}` };
}

function pageSnapshots(doc) {
  if (!snapshots.has(doc)) snapshots.set(doc, { agenda: { status: 'loading' }, work: { status: 'loading' } });
  return snapshots.get(doc);
}

function writeSummary(doc, kind, value, detail, status) {
  const item = doc.querySelector(`#summary-${kind}`);
  if (item) item.dataset.state = status;
  for (const [part, text] of [['value', value], ['detail', detail]]) {
    const node = doc.querySelector(`#summary-${kind}-${part}`);
    if (node && node.textContent !== text) node.textContent = text;
  }
}

export function renderDashboardSummary(doc = globalThis.document, now = new Date()) {
  if (!doc) return;
  const { agenda, work } = pageSnapshots(doc);
  if (available(agenda)) {
    const summary = summarizeAgenda(agenda.events, agenda.window, now);
    writeSummary(doc, 'agenda', agenda.limited && summary.value === 'Aucun à venir' ? 'Aucun dans l’aperçu' : summary.value,
      `${agenda.status === 'stale' ? 'Dernières données · ' : ''}${agenda.limited ? 'Aperçu limité · ' : ''}${summary.detail}`, agenda.status);
  } else writeSummary(doc, 'agenda', '—', agenda.status === 'loading' ? 'Chargement de l’agenda…' : 'Agenda non disponible', agenda.status);
  if (available(work) && work.work) {
    const summary = summarizeIntranetWork(work.work, now);
    const detail = (count, noun, limited) => `${work.status === 'stale' ? 'Dernières données · ' : ''}${limited ? 'Aperçu limité · ' : 'Sur '}${count} ${noun}${count === 1 ? '' : 's'}`;
    writeSummary(doc, 'tasks', String(summary.overdueTasks), detail(summary.taskCount, 'tâche', summary.tasksHasMore), work.status);
    writeSummary(doc, 'tickets', String(summary.priorityTickets), detail(summary.ticketCount, 'ticket', summary.ticketsHasMore), work.status);
  } else {
    for (const kind of ['tasks', 'tickets']) writeSummary(doc, kind, '—', work.status === 'loading' ? 'Chargement de l’intranet…' : 'Intranet non disponible', work.status);
  }
}

export function setAgendaSummary(snapshot, doc = globalThis.document, now = new Date()) {
  if (!doc) return;
  pageSnapshots(doc).agenda = available(snapshot) ? snapshot : { status: snapshot.status };
  renderDashboardSummary(doc, now);
}

export function setWorkSummary(snapshot, doc = globalThis.document, now = new Date()) {
  if (!doc) return;
  pageSnapshots(doc).work = available(snapshot) ? snapshot : { status: snapshot.status };
  renderDashboardSummary(doc, now);
}
