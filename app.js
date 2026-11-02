'use strict';

const $ = (selector) => document.querySelector(selector);
const key = 'mon-espace-v1';
const uid = () => crypto.randomUUID();
const localDay = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const today = () => localDay();
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const icon = (name) => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const parseDay = (value) => new Date(`${value}T12:00:00`);
const validDay = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(parseDay(value).getTime()) && localDay(parseDay(value)) === value;
const dateLabel = (value, options = { day: 'numeric', month: 'short' }) => validDay(value) ? new Intl.DateTimeFormat('fr-CH', options).format(parseDay(value)) : '';
const safeUrl = (value) => { try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : null; } catch { return null; } };
const short = (value, max = 300) => typeof value === 'string' ? value.slice(0, max) : '';
const asList = (value) => Array.isArray(value) ? value.slice(0, 5000) : [];
const defaultTimer = (minutes = 25) => ({ duration: minutes, remaining: minutes * 60, end: null, completed: false });

function initialState() {
  return { schema: 1, name: '', welcomeDismissed: false, notes: '', projects: [], links: [], focusLog: {}, timer: defaultTimer(),
    tasks: [
      { id: uid(), title: 'Choisir mes trois priorités', category: 'personal', priority: 'high', date: today(), project: '', done: false },
      { id: uid(), title: 'Donner vie à mon premier projet', category: 'work', priority: 'normal', date: today(), project: '', done: false },
      { id: uid(), title: 'Garder un moment pour moi', category: 'personal', priority: 'normal', date: today(), project: '', done: false }
    ],
    habits: [
      { id: uid(), title: 'Bouger un peu', days: [] },
      { id: uid(), title: 'Lire quelques pages', days: [] },
      { id: uid(), title: 'Faire une vraie pause', days: [] }
    ]
  };
}

function normalize(raw) {
  if (!raw || raw.schema !== 1 || !Array.isArray(raw.tasks) || !Array.isArray(raw.habits) || !Array.isArray(raw.projects) || !Array.isArray(raw.links)) throw new Error('Format de sauvegarde non reconnu.');
  const id = (value) => short(value, 100) || uid();
  const result = {
    schema: 1, name: short(raw.name, 40), welcomeDismissed: !!raw.welcomeDismissed, notes: short(raw.notes, 200000),
    projects: asList(raw.projects).filter(x => x && typeof x.title === 'string').map(x => ({ id: id(x.id), title: short(x.title, 120), description: short(x.description, 1000), date: validDay(x.date) ? x.date : '', color: ['sage', 'lilac', 'peach'].includes(x.color) ? x.color : 'sage' })),
    tasks: asList(raw.tasks).filter(x => x && typeof x.title === 'string').map(x => ({ id: id(x.id), title: short(x.title, 200), category: x.category === 'work' ? 'work' : 'personal', priority: ['high', 'normal', 'low'].includes(x.priority) ? x.priority : 'normal', date: validDay(x.date) ? x.date : '', project: short(x.project, 100), done: !!x.done })),
    habits: asList(raw.habits).filter(x => x && typeof x.title === 'string').map(x => ({ id: id(x.id), title: short(x.title, 100), days: [...new Set(asList(x.days).filter(validDay))] })),
    links: asList(raw.links).filter(x => x && typeof x.title === 'string' && safeUrl(x.url)).map(x => ({ id: id(x.id), title: short(x.title, 50), url: safeUrl(x.url) })),
    focusLog: Object.fromEntries(Object.entries(raw.focusLog && typeof raw.focusLog === 'object' ? raw.focusLog : {}).filter(([date, value]) => validDay(date) && Number.isFinite(value) && value >= 0).map(([date, value]) => [date, Math.min(value, 86400)])),
    timer: defaultTimer()
  };
  const t = raw.timer;
  if (t && [15, 25, 45, 60].includes(t.duration)) {
    result.timer = { duration: t.duration, remaining: Number.isFinite(t.remaining) ? Math.max(0, Math.min(t.duration * 60, t.remaining)) : t.duration * 60, end: Number.isFinite(t.end) && t.end <= Date.now() + t.duration * 60000 ? t.end : null, completed: !!t.completed };
  }
  result.tasks.forEach(task => { if (!result.projects.some(project => project.id === task.project)) task.project = ''; });
  return result;
}

let state;
let storageFailed = false;
let recoveryData = null;
let savedData = null;
try { savedData = localStorage.getItem(key); state = savedData ? normalize(JSON.parse(savedData)) : initialState(); }
catch { state = initialState(); storageFailed = true; recoveryData = savedData; }
let currentView = 'overview';
let selectedDay = today();
let taskFilter = 'all';
let modalMode = '';
let editingId = '';
let dialogTrigger;
let toastTimeout;
let undoAction;
let previousDay = today();

function save() {
  try { if (recoveryData !== null) throw new Error('Recovery required'); localStorage.setItem(key, JSON.stringify(state)); storageFailed = false; }
  catch { storageFailed = true; }
  $('#storage-warning').hidden = !storageFailed;
  $('#storage-warning').textContent = recoveryData !== null ? 'La sauvegarde existante est illisible. Elle est conservée : ouvrez « Personnaliser » pour exporter l’original ou repartir avec cet espace.' : 'La sauvegarde locale est indisponible. Exportez vos données dans « Personnaliser » pour les conserver.';
  document.querySelector('.storage-status span:last-child').textContent = storageFailed ? 'Sauvegarde indisponible' : 'Sauvegarde dans ce navigateur';
  return !storageFailed;
}

function toast(message, undo) {
  clearTimeout(toastTimeout);
  $('#toast-message').textContent = message;
  $('#toast-undo').hidden = !undo;
  undoAction = undo;
  $('#toast').hidden = false;
  toastTimeout = setTimeout(() => { $('#toast').hidden = true; undoAction = null; }, undo ? 10000 : 4500);
}

function weekDays() {
  const monday = parseDay(today());
  monday.setDate(monday.getDate() - (monday.getDay() + 6) % 7);
  return Array.from({ length: 7 }, (_, index) => { const day = new Date(monday); day.setDate(day.getDate() + index); return localDay(day); });
}

function renderHeader() {
  $('#top-date').textContent = new Intl.DateTimeFormat('fr-CH', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());
  const hour = new Date().getHours();
  const greeting = hour >= 18 ? 'Bonsoir' : 'Bonjour';
  $('#greeting').textContent = `${greeting}${state.name ? ', ' + state.name : ''} — À VOTRE RYTHME`;
  $('#profile-name').textContent = state.name ? `L’espace de ${state.name}` : 'Mon espace personnel';
  $('#avatar').textContent = state.name ? state.name.charAt(0).toLocaleUpperCase('fr') : 'M';
  $('#welcome-card').hidden = state.welcomeDismissed;
}

function renderSummary() {
  const completed = state.tasks.filter(task => task.done).length;
  $('#summary-tasks').innerHTML = `${completed} <small>/ ${state.tasks.length}</small>`;
  $('#summary-percent').textContent = `${state.tasks.length ? Math.round(completed / state.tasks.length * 100) : 0} %`;
  $('#summary-projects').textContent = state.projects.filter(project => { const tasks = state.tasks.filter(task => task.project === project.id); return !tasks.length || tasks.some(task => !task.done); }).length;
  $('#summary-focus').innerHTML = `${Math.floor((state.focusLog[today()] || 0) / 60)} <small>min</small>`;
  $('#nav-task-count').textContent = state.tasks.filter(task => !task.done).length;
}

function taskMarkup(task) {
  const project = state.projects.find(project => project.id === task.project);
  const late = task.date && task.date < today() && !task.done;
  return `<div class="task-row ${task.done ? 'is-done' : ''}"><button class="task-check ${task.done ? 'checked' : ''}" data-action="toggle-task" data-id="${esc(task.id)}" aria-label="${esc((task.done ? 'Marquer à faire : ' : 'Terminer : ') + task.title)}" aria-pressed="${task.done}">${task.done ? icon('check') : ''}</button><div class="task-content"><button class="task-title" data-action="edit-task" data-id="${esc(task.id)}">${esc(task.title)}</button><div class="task-meta"><span class="tag tag-${task.category}">${esc(project?.title || (task.category === 'work' ? 'Travail' : 'Personnel'))}</span>${task.priority === 'high' ? '<span class="priority-marker">Priorité haute</span>' : ''}${task.date ? `<span class="task-date ${late ? 'overdue' : ''}">${late ? 'En retard · ' : ''}${dateLabel(task.date)}</span>` : '<span class="task-date">Sans échéance</span>'}</div></div><div class="task-actions"><button class="icon-button" data-action="edit-task" data-id="${esc(task.id)}" aria-label="${esc('Modifier : ' + task.title)}">${icon('edit')}</button><button class="icon-button" data-action="delete-task" data-id="${esc(task.id)}" aria-label="${esc('Supprimer : ' + task.title)}">${icon('trash')}</button></div></div>`;
}

function emptyState(title, description, action, label, symbol = 'leaf') {
  return `<div class="empty-state"><span class="empty-icon">${icon(symbol)}</span><h3>${esc(title)}</h3><p>${esc(description)}</p>${action ? `<button class="button button-secondary" data-action="${action}">${icon('plus')}${esc(label)}</button>` : ''}</div>`;
}

function renderTasks() {
  $('#week-strip').innerHTML = weekDays().map(date => `<button class="day-pill ${date === today() ? 'is-today' : ''} ${date === selectedDay ? 'selected' : ''}" data-day="${date}" aria-label="${esc(dateLabel(date, { weekday: 'long', day: 'numeric', month: 'long' }))}${date === today() ? ', aujourd’hui' : ''}" aria-pressed="${date === selectedDay}"><span>${dateLabel(date, { weekday: 'short' }).replace('.', '')}</span><strong>${parseDay(date).getDate()}</strong><small class="day-dot ${state.tasks.some(task => task.date === date && !task.done) ? 'has-tasks' : ''}"></small></button>`).join('');
  const dayTasks = state.tasks.filter(task => task.date === selectedDay || (!task.date && selectedDay === today())).sort((a, b) => Number(a.done) - Number(b.done));
  $('#selected-day-label').textContent = selectedDay === today() ? 'Vos priorités du jour, et les tâches sans échéance.' : dateLabel(selectedDay, { weekday: 'long', day: 'numeric', month: 'long' });
  $('#daily-count').textContent = dayTasks.filter(task => !task.done).length;
  $('#daily-tasks').innerHTML = dayTasks.length ? dayTasks.map(taskMarkup).join('') : emptyState('Une page encore libre', 'Ajoutez une intention pour cette journée.', 'add-task', 'Ajouter une tâche', 'sun');
  const tasks = state.tasks.filter(task => taskFilter === 'all' || (taskFilter === 'done' ? task.done : !task.done)).sort((a, b) => Number(a.done) - Number(b.done) || (a.date || '9999').localeCompare(b.date || '9999'));
  $('#all-tasks').innerHTML = tasks.length ? tasks.map(taskMarkup).join('') : emptyState(taskFilter === 'done' ? 'Chaque petit pas compte' : 'Tout est au clair', taskFilter === 'done' ? 'Vos tâches terminées apparaîtront ici.' : 'Ajoutez votre prochaine tâche quand vous le souhaitez.', taskFilter === 'done' ? null : 'add-task', 'Ajouter une tâche', 'task');
  document.querySelectorAll('[data-filter]').forEach(button => { button.classList.toggle('active', button.dataset.filter === taskFilter); button.setAttribute('aria-pressed', String(button.dataset.filter === taskFilter)); });
}

function projectMarkup(project, compact = false) {
  const tasks = state.tasks.filter(task => task.project === project.id);
  const done = tasks.filter(task => task.done).length;
  const percent = tasks.length ? Math.round(done / tasks.length * 100) : 0;
  return `<article class="project-card ${esc(project.color)} ${compact ? 'compact' : 'card'}"><div class="project-top"><span class="project-icon ${esc(project.color)}">${icon('folder')}</span><div class="task-actions"><button class="icon-button" data-action="edit-project" data-id="${esc(project.id)}" aria-label="${esc('Modifier le projet : ' + project.title)}">${icon('edit')}</button><button class="icon-button" data-action="delete-project" data-id="${esc(project.id)}" aria-label="${esc('Supprimer le projet : ' + project.title)}">${icon('trash')}</button></div></div><h3>${esc(project.title)}</h3>${project.description ? `<p class="project-description">${esc(project.description)}</p>` : ''}<div class="project-progress-label"><span>${done} / ${tasks.length} tâche${tasks.length > 1 ? 's' : ''}</span><strong>${percent} %</strong></div><div class="progress-track" role="progressbar" aria-label="${esc('Progression de ' + project.title)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"><span class="progress-fill" style="width:${percent}%"></span></div><div class="project-footer"><span>${project.date ? icon('clock') + dateLabel(project.date) : 'À votre rythme'}</span><button class="text-button" data-action="project-task" data-id="${esc(project.id)}">${icon('plus')}Une tâche</button></div></article>`;
}

function renderProjects() {
  $('#overview-projects').innerHTML = state.projects.length ? `<div class="overview-project-grid">${state.projects.slice(0, 2).map(project => projectMarkup(project, true)).join('')}</div>${state.projects.length > 2 ? '<button class="card-bottom-link text-button" data-view="projects">Voir tous mes projets ' + icon('arrow') + '</button>' : ''}` : `<div class="project-starter"><span class="project-starter-art" aria-hidden="true">${icon('folder')}</span><div><h3>Quel sera votre prochain projet ?</h3><p>Un voyage, une idée à lancer, une nouvelle envie…</p><button class="text-button" data-action="add-project">Créer mon premier projet ${icon('arrow')}</button></div></div>`;
  $('#all-projects').innerHTML = state.projects.length ? state.projects.map(project => projectMarkup(project)).join('') : `<div class="card">${emptyState('Les grandes idées commencent ici', 'Donnez un nom à votre projet, puis avancez tâche après tâche.', 'add-project', 'Créer mon premier projet', 'folder')}</div>`;
}

function renderHabits() {
  $('#habits-list').innerHTML = state.habits.length ? state.habits.map((habit, index) => { const done = habit.days.includes(today()); return `<div class="habit-row"><span class="habit-icon habit-icon-${index % 3}">${icon(['leaf', 'note', 'sun'][index % 3])}</span><div class="habit-text"><strong>${esc(habit.title)}</strong><small>${done ? 'Un petit pas de plus !' : 'Votre rituel du jour'}</small></div><button class="habit-toggle ${done ? 'checked' : ''}" data-action="toggle-habit" data-id="${esc(habit.id)}" aria-pressed="${done}" aria-label="${esc((done ? 'Annuler : ' : 'Valider : ') + habit.title)}">${done ? icon('check') : icon('plus')}</button><button class="icon-button habit-delete" data-action="delete-habit" data-id="${esc(habit.id)}" aria-label="${esc('Supprimer l’habitude : ' + habit.title)}">${icon('close')}</button></div>`; }).join('') : '<p class="muted empty-habits">Créez un rituel qui vous fait du bien.</p>';
  const completed = state.habits.filter(habit => habit.days.includes(today())).length;
  $('#habit-caption').textContent = completed ? `${completed} rituel${completed > 1 ? 's' : ''} sur ${state.habits.length} accompli${completed > 1 ? 's' : ''} aujourd’hui.` : 'Un peu chaque jour, c’est déjà beaucoup.';
  $('#habit-week').innerHTML = weekDays().map(date => { const allDone = state.habits.length > 0 && state.habits.every(habit => habit.days.includes(date)); const count = state.habits.filter(habit => habit.days.includes(date)).length; return `<div class="habit-day ${allDone ? 'done' : ''} ${date === today() ? 'today' : ''}" title="${esc(dateLabel(date))} : ${count} rituel(s) accompli(s)"><span>${dateLabel(date, { weekday: 'narrow' })}</span><span class="habit-day-circle">${allDone ? icon('check') : (count ? '<span class="partial-dot"></span>' : '·')}</span></div>`; }).join('');
}

function renderLinks() {
  $('#quick-links').innerHTML = state.links.map(link => `<div class="quick-link-wrap"><a class="quick-link" href="${esc(safeUrl(link.url))}" target="_blank" rel="noopener noreferrer"><span class="link-icon">${esc(link.title.charAt(0).toLocaleUpperCase('fr'))}</span><span>${esc(link.title)}</span>${icon('external')}</a><button class="icon-button link-delete" data-action="delete-link" data-id="${esc(link.id)}" aria-label="${esc('Supprimer le raccourci : ' + link.title)}">${icon('close')}</button></div>`).join('') + `<button class="quick-link quick-link-add" data-action="add-link"><span class="link-icon">${icon('plus')}</span><span>Ajouter un lien</span></button>`;
}

function renderNotes() {
  $('#quick-note').value = state.notes;
  $('#full-note').value = state.notes;
  updateWordCount();
}
function updateWordCount() { const count = state.notes.trim() ? state.notes.trim().split(/\s+/).length : 0; $('#note-word-count').textContent = `${count} mot${count > 1 ? 's' : ''}`; }
function renderAll() { renderHeader(); renderSummary(); renderTasks(); renderProjects(); renderHabits(); renderLinks(); renderNotes(); updateTimer(); }

function navigate(view, focusHeading = true) {
  if (!['overview', 'tasks', 'projects', 'notes'].includes(view)) view = 'overview';
  currentView = view;
  document.querySelectorAll('.view').forEach(section => { section.hidden = section.id !== `view-${view}`; });
  document.querySelectorAll('.nav-button[data-view]').forEach(button => { const active = button.dataset.view === view; button.classList.toggle('active', active); if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current'); });
  $('#breadcrumb-current').textContent = { overview: 'Vue d’ensemble', tasks: 'Mes tâches', projects: 'Mes projets', notes: 'Mes notes' }[view];
  if (location.hash !== `#${view}`) history.replaceState(null, '', `#${view}`);
  if (focusHeading) { const heading = $(`#view-${view} h1`); heading.tabIndex = -1; heading.focus({ preventScroll: true }); window.scrollTo({ top: 0, behavior: 'instant' }); }
}

const field = (label, html) => `<div class="field"><label>${label}${html}</label></div>`;
function openModal(mode, entityId = '', projectId = '') {
  modalMode = mode; editingId = entityId; dialogTrigger = document.activeElement;
  $('#form-error').hidden = true;
  let title, body;
  if (mode === 'task') {
    const task = state.tasks.find(x => x.id === entityId) || { title: '', date: currentView === 'overview' ? selectedDay : today(), category: 'personal', priority: 'normal', project: projectId };
    title = entityId ? 'Modifier ma tâche' : 'Un nouveau petit pas';
    body = field('Que souhaitez-vous faire ?', `<input name="title" required maxlength="200" value="${esc(task.title)}" placeholder="Une action simple et concrète" autocomplete="off">`) + '<div class="form-grid">' + field('Date', `<input type="date" name="date" value="${esc(task.date)}">`) + field('Priorité', `<select name="priority">${[['normal', 'Normale'], ['high', 'Haute'], ['low', 'Basse']].map(([v, l]) => `<option value="${v}" ${task.priority === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`) + '</div>' + '<div class="form-grid">' + field('Catégorie', `<select name="category"><option value="personal">Personnel</option><option value="work" ${task.category === 'work' ? 'selected' : ''}>Travail</option></select>`) + field('Projet', `<select name="project"><option value="">Sans projet</option>${state.projects.map(project => `<option value="${esc(project.id)}" ${task.project === project.id ? 'selected' : ''}>${esc(project.title)}</option>`).join('')}</select>`) + '</div>';
  } else if (mode === 'project') {
    const project = state.projects.find(x => x.id === entityId) || { title: '', description: '', date: '', color: 'sage' };
    title = entityId ? 'Modifier mon projet' : 'Une envie à concrétiser';
    body = field('Nom du projet', `<input name="title" required maxlength="120" value="${esc(project.title)}" placeholder="Mon prochain projet" autocomplete="off">`) + field('Quelques mots (facultatif)', `<textarea name="description" maxlength="1000" rows="3" placeholder="Ce que j’aimerais accomplir…">${esc(project.description)}</textarea>`) + '<div class="form-grid">' + field('Date cible (facultatif)', `<input type="date" name="date" value="${esc(project.date)}">`) + field('Couleur', `<select name="color">${[['sage', 'Sauge'], ['lilac', 'Lavande'], ['peach', 'Abricot']].map(([v, l]) => `<option value="${v}" ${project.color === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`) + '</div>';
  } else if (mode === 'habit') {
    title = 'Un petit rituel à cultiver';
    body = '<p class="form-description">Choisissez un geste simple que vous aimeriez répéter chaque jour.</p>' + field('Mon rituel', '<input name="title" required maxlength="100" placeholder="Marcher 20 minutes, lire, méditer…" autocomplete="off">');
  } else if (mode === 'link') {
    title = 'Un raccourci vers l’essentiel';
    body = field('Nom du raccourci', '<input name="title" required maxlength="50" placeholder="Mon agenda, mes documents…" autocomplete="off">') + field('Adresse du site', '<input name="url" type="url" required placeholder="https://…" autocomplete="url">');
  } else {
    title = 'Un espace à votre image';
    body = field('Comment vous appeler ? (facultatif)', `<input name="name" maxlength="40" value="${esc(state.name)}" placeholder="Votre prénom" autocomplete="given-name">`) + '<div class="settings-row"><h3>Vos données, avec vous</h3><p>Le contenu est enregistré uniquement dans ce navigateur. Exportez une copie pour le conserver ou le transférer sur un autre appareil.</p><div class="settings-actions"><button type="button" class="button button-secondary" data-action="export">' + icon('download') + 'Exporter</button><button type="button" class="button button-secondary" data-action="import">Importer une copie</button></div><p class="small-note">Une importation remplacera le contenu actuel après confirmation.</p></div>' + (recoveryData !== null ? '<div class="settings-row"><h3>Récupérer votre sauvegarde</h3><p>Le fichier d’origine n’a pas été remplacé. Téléchargez-le avant de repartir.</p><div class="settings-actions"><button type="button" class="button button-secondary" data-action="export-recovery">Exporter l’original</button><button type="button" class="button button-danger" data-action="reset-recovery">Repartir avec cet espace</button></div></div>' : '');
  }
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = body;
  $('#modal-submit').textContent = mode === 'settings' || entityId ? 'Enregistrer' : 'Ajouter';
  $('#modal').showModal();
  requestAnimationFrame(() => $('#modal-body input')?.focus());
}

function closeModal() { $('#modal').close(); }
$('#modal').addEventListener('close', () => {
  if (dialogTrigger?.isConnected) { dialogTrigger.focus(); return; }
  const action = dialogTrigger?.dataset.action, entityId = dialogTrigger?.dataset.id;
  const replacement = action ? $(`#view-${currentView} [data-action="${CSS.escape(action)}"]${entityId ? `[data-id="${CSS.escape(entityId)}"]` : ''}`) : null;
  const target = replacement || $(`#view-${currentView} h1`);
  target.tabIndex = target.matches('h1') ? -1 : target.tabIndex;
  target.focus({ preventScroll: true });
});
$('#modal-form').addEventListener('submit', event => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.currentTarget));
  if (data.title !== undefined) data.title = data.title.trim();
  if (data.title === '') { $('#form-error').textContent = 'Ajoutez un nom pour continuer.'; $('#form-error').hidden = false; return; }
  if (data.date && !validDay(data.date)) { $('#form-error').textContent = 'Choisissez une date valide.'; $('#form-error').hidden = false; return; }
  if (modalMode === 'task') {
    const existing = state.tasks.find(x => x.id === editingId);
    const task = { id: existing?.id || uid(), title: data.title, date: data.date, priority: data.priority, category: data.category, project: data.project, done: existing?.done || false };
    if (existing) Object.assign(existing, task); else state.tasks.push(task);
  } else if (modalMode === 'project') {
    const existing = state.projects.find(x => x.id === editingId);
    const project = { id: existing?.id || uid(), title: data.title, description: data.description.trim(), date: data.date, color: data.color };
    if (existing) Object.assign(existing, project); else state.projects.push(project);
  } else if (modalMode === 'habit') state.habits.push({ id: uid(), title: data.title, days: [] });
  else if (modalMode === 'link') {
    const url = safeUrl(data.url);
    if (!url) { $('#form-error').textContent = 'Utilisez une adresse commençant par https:// ou http://.'; $('#form-error').hidden = false; return; }
    state.links.push({ id: uid(), title: data.title, url });
  } else state.name = data.name.trim();
  const saved = save();
  closeModal(); renderAll();
  toast(saved ? (editingId || modalMode === 'settings' ? 'Les modifications sont enregistrées.' : 'C’est ajouté à votre espace.') : 'Modification appliquée. Exportez une copie pour la conserver.');
});

function removeItem(collection, entityId) {
  const index = state[collection].findIndex(item => item.id === entityId);
  if (index < 0) return;
  const [removed] = state[collection].splice(index, 1);
  const linkedTasks = collection === 'projects' ? state.tasks.filter(task => task.project === entityId).map(task => task.id) : [];
  linkedTasks.forEach(taskId => { state.tasks.find(task => task.id === taskId).project = ''; });
  save(); renderAll();
  toast(collection === 'projects' ? 'Projet supprimé. Ses tâches sont conservées.' : 'Élément supprimé.', () => {
    state[collection].splice(Math.min(index, state[collection].length), 0, removed);
    linkedTasks.forEach(taskId => { const task = state.tasks.find(item => item.id === taskId); if (task && !task.project) task.project = entityId; });
    save(); renderAll(); toast('Suppression annulée.');
  });
}

function updateTimer() {
  const timer = state.timer;
  let remaining = timer.end ? Math.max(0, Math.ceil((timer.end - Date.now()) / 1000)) : timer.remaining;
  if (timer.end && remaining <= 0) {
    const finishDay = localDay(new Date(timer.end));
    state.focusLog[finishDay] = (state.focusLog[finishDay] || 0) + timer.duration * 60;
    timer.end = null; timer.remaining = 0; timer.completed = true;
    save(); renderSummary(); toast('Session terminée. Prenez une petite pause.');
  }
  $('#timer-value').textContent = `${String(Math.floor(remaining / 60)).padStart(2, '0')}:${String(Math.floor(remaining % 60)).padStart(2, '0')}`;
  $('#timer-caption').textContent = timer.completed ? 'Bien joué. Respirez un peu.' : timer.end ? 'C’est votre moment.' : remaining < timer.duration * 60 ? 'Reprenez quand vous voulez.' : 'Une seule chose à la fois.';
  $('#timer-toggle').innerHTML = icon(timer.end ? 'pause' : 'play') + `<span>${timer.end ? 'Pause' : timer.completed ? 'Nouvelle session' : remaining < timer.duration * 60 ? 'Reprendre' : 'Commencer'}</span>`;
  $('#focus-duration').value = timer.duration;
  $('#focus-duration').disabled = !!timer.end;
  $('#focus-orbit').style.setProperty('--progress', `${Math.max(0, (1 - remaining / (timer.duration * 60)) * 360)}deg`);
}

function toggleTimer() {
  updateTimer();
  const timer = state.timer;
  if (timer.end) { timer.remaining = Math.max(0, Math.ceil((timer.end - Date.now()) / 1000)); timer.end = null; }
  else { if (!timer.remaining || timer.completed) { timer.remaining = timer.duration * 60; timer.completed = false; } timer.end = Date.now() + timer.remaining * 1000; }
  save(); updateTimer();
}

function exportData(original = false) {
  const blob = new Blob([original ? recoveryData : JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = `mon-espace-${original ? 'original-' : ''}${today()}.json`; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  toast('Votre copie est prête à être téléchargée.');
}

document.addEventListener('click', event => {
  const viewButton = event.target.closest('[data-view]');
  if (viewButton) { navigate(viewButton.dataset.view); return; }
  const dayButton = event.target.closest('[data-day]');
  if (dayButton) { selectedDay = dayButton.dataset.day; renderTasks(); $(`[data-day="${selectedDay}"]`)?.focus(); return; }
  const filterButton = event.target.closest('[data-filter]');
  if (filterButton) { taskFilter = filterButton.dataset.filter; renderTasks(); filterButton.focus(); return; }
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const action = button.dataset.action, entityId = button.dataset.id;
  if (action === 'add-task') openModal('task');
  else if (action === 'edit-task') openModal('task', entityId);
  else if (action === 'add-project') openModal('project');
  else if (action === 'edit-project') openModal('project', entityId);
  else if (action === 'project-task') openModal('task', '', entityId);
  else if (action === 'add-habit') openModal('habit');
  else if (action === 'add-link') openModal('link');
  else if (action === 'settings') openModal('settings');
  else if (action === 'close-modal') closeModal();
  else if (action === 'dismiss-welcome') { state.welcomeDismissed = true; save(); renderHeader(); }
  else if (action === 'toggle-task') {
    const task = state.tasks.find(item => item.id === entityId); if (!task) return;
    task.done = !task.done; save(); renderTasks(); renderProjects(); renderSummary();
    $(`${currentView === 'overview' ? '#daily-tasks' : '#all-tasks'} [data-action="toggle-task"][data-id="${CSS.escape(entityId)}"]`)?.focus();
  } else if (action === 'toggle-habit') {
    const habit = state.habits.find(item => item.id === entityId); if (!habit) return;
    habit.days = habit.days.includes(today()) ? habit.days.filter(date => date !== today()) : [...habit.days, today()];
    save(); renderHabits(); $(`[data-action="toggle-habit"][data-id="${CSS.escape(entityId)}"]`)?.focus();
  } else if (action.startsWith('delete-')) removeItem({ 'delete-task': 'tasks', 'delete-project': 'projects', 'delete-habit': 'habits', 'delete-link': 'links' }[action], entityId);
  else if (action === 'timer-toggle') toggleTimer();
  else if (action === 'timer-reset') { state.timer = defaultTimer(state.timer.duration); save(); updateTimer(); }
  else if (action === 'export') exportData();
  else if (action === 'export-recovery') exportData(true);
  else if (action === 'reset-recovery') {
    if (window.confirm('Remplacer la sauvegarde illisible par cet espace ? Exportez d’abord l’original pour conserver une copie.')) { recoveryData = null; save(); closeModal(); toast('Votre espace peut à nouveau être sauvegardé.'); }
  }
  else if (action === 'import') $('#import-file').click();
  else if (action === 'dismiss-toast') { $('#toast').hidden = true; undoAction = null; }
});

$('#toast-undo').addEventListener('click', () => { const action = undoAction; undoAction = null; action?.(); });
$('#focus-duration').addEventListener('change', event => { state.timer = defaultTimer(Number(event.target.value)); save(); updateTimer(); });
for (const selector of ['#quick-note', '#full-note']) {
  $(selector).maxLength = 200000;
  $(selector).addEventListener('input', event => {
    state.notes = event.target.value;
    const other = selector === '#quick-note' ? '#full-note' : '#quick-note';
    $(other).value = state.notes;
    const saved = save();
    $('#note-save-label').textContent = saved ? 'Enregistré à l’instant' : 'Sauvegarde indisponible';
    $('#full-note-save').textContent = saved ? 'Enregistré dans ce navigateur' : 'Sauvegarde indisponible';
    updateWordCount();
  });
}
$('#import-file').addEventListener('change', async event => {
  const file = event.target.files[0]; if (!file) return;
  try {
    if (file.size > 5000000) throw new Error('Ce fichier est trop volumineux (5 Mo maximum).');
    const imported = normalize(JSON.parse(await file.text()));
    if (!window.confirm('Remplacer le contenu actuel par cette copie ? Pensez à exporter vos données actuelles avant de continuer.')) return;
    const before = structuredClone(state);
    state = imported; recoveryData = null; save(); renderAll();
    toast('Votre copie a été importée.', () => { state = before; save(); renderAll(); toast('Importation annulée.'); });
  } catch (error) { toast(error instanceof SyntaxError ? 'Ce fichier ne contient pas une sauvegarde JSON valide.' : error.message); }
  finally { event.target.value = ''; }
});

window.addEventListener('hashchange', () => navigate(location.hash.slice(1)));
document.addEventListener('visibilitychange', () => { if (!document.hidden) updateTimer(); });
setInterval(() => {
  updateTimer();
  if (previousDay !== today()) { previousDay = today(); selectedDay = today(); renderAll(); }
}, 1000);

renderAll();
navigate(location.hash.slice(1) || 'overview', false);
save();
