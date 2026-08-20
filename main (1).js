// =============================================================================
// main.js — точка входа. Состояние приложения, рендер экранов, обработчики.
//
// Структура упрощена по итогам UX-разбора: 4 вкладки вместо 5, единственная
// система навигации (нижняя панель — без дублирующих иконок в шапке и без
// тизеров-ссылок в теле экрана, кроме одной «все →» на главной). Заметки,
// дневник и задачи живут на одной вкладке «Записи» с переключателем сверху;
// карта мыслей — это просто другой способ посмотреть на ту же вкладку.
// Статистика и настройки перенесены на вкладку «Профиль», чтобы не грузить
// главный экран сразу восемью блоками.
// =============================================================================

import { Storage } from './storage.js';
import { Together } from './together.js';
import { TG } from './telegram.js';

// ------------------------------------------------------------------- state
const state = {
  view: 'home', // home | records | chat | profile
  recordsFilter: 'all', // all | notes | journal | tasks
  recordsView: 'list', // list | map
  recordsQuery: '',
  tasksFilter: 'open',
  editingNoteId: null, // null = создаём новую заметку
  journalMood: null,
  chatSending: false,
  extractedTasksBuffer: [], // временный буфер результатов "обработать заметку" в модалке заметки
  profileRange: 'week',
};

const MOODS = [
  { id: 'bad', emoji: '😔', label: 'Тяжело' },
  { id: 'meh', emoji: '😕', label: 'Так себе' },
  { id: 'ok', emoji: '😐', label: 'Нормально' },
  { id: 'good', emoji: '🙂', label: 'Хорошо' },
  { id: 'great', emoji: '😄', label: 'Отлично' },
];

const MONTHS_SHORT = ['Янв','Фев','Мар','Апр','Май','Июн','Июл','Авг','Сен','Окт','Ноя','Дек'];
const WEEKDAYS_SHORT = ['Вс','Пн','Вт','Ср','Чт','Пт','Сб'];

// ------------------------------------------------------------------- utils
function $(sel, root = document) { return root.querySelector(sel); }
function $all(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }

function escapeHtml(str = '') {
  return str.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtDate(ts) {
  const d = new Date(ts);
  const today = new Date();
  const isToday = d.toDateString() === today.toDateString();
  const yest = new Date(today);
  yest.setDate(yest.getDate() - 1);
  const isYesterday = d.toDateString() === yest.toDateString();
  if (isToday) return 'сегодня, ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  if (isYesterday) return 'вчера, ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

function emptyStateHTML(msg = 'Пока пусто.') {
  return `<div class="empty-state">${escapeHtml(msg)}</div>`;
}

let toastTimer = null;
function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

function autoGrow(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = Math.min(textarea.scrollHeight, 160) + 'px';
}

async function withBusy(button, fn, busyLabel = '…') {
  if (!button) return fn();
  const original = button.innerHTML;
  button.disabled = true;
  button.dataset.busy = '1';
  button.innerHTML = `<span>${busyLabel}</span>`;
  try {
    return await fn();
  } finally {
    button.disabled = false;
    delete button.dataset.busy;
    button.innerHTML = original;
  }
}

function handleError(err, fallback = 'Что-то пошло не так') {
  console.error(err);
  const msg = err && err.message ? err.message : fallback;
  toast(msg, 3600);
  TG.haptic('error');
}

// небольшой стабильный "хэш" строки в число 0..1 — нужен для карты мыслей,
// чтобы одна и та же заметка всегда попадала в одно и то же место на графе.
function hash01(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) { h = (h * 31 + str.charCodeAt(i)) >>> 0; }
  return (h % 1000) / 1000;
}

// ------------------------------------------------------------------- categories
function fillCategorySelects() {
  const cats = Storage.getCategories();
  const options = cats.map((c) => `<option value="${c.id}">${escapeHtml(c.label)}</option>`).join('');
  $('#captureCategory').innerHTML = options;
  $('#noteCategory').innerHTML = options;
}

// ------------------------------------------------------------------- navigation
function switchView(view) {
  state.view = view;
  $all('.view').forEach((v) => v.classList.toggle('is-active', v.dataset.view === view));
  $all('.tabbar__item').forEach((b) => b.classList.toggle('is-active', b.dataset.nav === view));
  const subtitles = {
    home: 'каталог мыслей',
    records: 'заметки, дневник, задачи',
    chat: 'разговор с базой знаний',
    profile: 'статистика и настройки',
  };
  $('#topbarSubtitle').textContent = subtitles[view] || '';

  if (view === 'home') renderHome();
  if (view === 'records') renderRecordsScreen();
  if (view === 'chat') renderChat();
  if (view === 'profile') renderProfile();
}

function bindNav() {
  document.body.addEventListener('click', (e) => {
    const navBtn = e.target.closest('[data-nav]');
    if (navBtn) {
      TG.haptic('selection');
      switchView(navBtn.dataset.nav);
    }
  });
}

// ------------------------------------------------------------------- HOME
// Только захват мысли + свежая лента — никакой статистики и графиков здесь.
function renderHome() {
  const recent = [...Storage.getNotes()].sort((a, b) => (b.pinned - a.pinned) || (b.updatedAt - a.updatedAt)).slice(0, 4);
  $('#homeRecent').innerHTML = recent.length
    ? recent.map(renderNoteCardHTML).join('')
    : emptyStateHTML('Пока пусто. Запишите первую мысль выше — я разложу её по полочкам.');
}

function bindHome() {
  const form = $('#captureForm');
  const input = $('#captureInput');
  input.addEventListener('input', () => autoGrow(input));

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    const category = $('#captureCategory').value;
    Storage.addNote({ body: text, category });
    input.value = '';
    autoGrow(input);
    TG.haptic('success');
    toast('Заметка сохранена');
    renderHome();
  });

  document.body.addEventListener('click', (e) => {
    const pinBtn = e.target.closest('[data-pin-toggle]');
    if (pinBtn && e.target.closest('#homeRecent')) {
      e.stopPropagation();
      Storage.togglePinNote(pinBtn.dataset.pinToggle);
      TG.haptic('selection');
      renderHome();
      return;
    }
    const card = e.target.closest('#homeRecent .note-card');
    if (card) openNoteModal(card.dataset.noteId);
  });
}

// ------------------------------------------------------------------- CARD RENDERERS (общие)
// Список заметок показывает только цвет+название категории, заголовок и
// первую строку — теги/дату/номер видно только после открытия карточки.
function renderNoteCardHTML(note) {
  const cat = Storage.categoryById(note.category);
  const title = note.title || (note.body.length > 46 ? note.body.slice(0, 46).trim() + '…' : note.body);
  const bodyPreview = note.title ? note.body : '';
  return `
    <article class="note-card${note.pinned ? ' is-pinned' : ''}" style="--cat-color:${cat.color}" data-note-id="${note.id}">
      <button class="note-card__pin${note.pinned ? ' is-active' : ''}" data-pin-toggle="${note.id}" type="button" aria-label="Закрепить" title="Закрепить">📌</button>
      <span class="note-card__cat">${escapeHtml(cat.label)}</span>
      <h3 class="note-card__title">${escapeHtml(title)}</h3>
      ${bodyPreview ? `<p class="note-card__body">${escapeHtml(bodyPreview)}</p>` : ''}
    </article>`;
}

function renderTaskRowHTML(task) {
  const note = task.sourceNoteId ? Storage.getNote(task.sourceNoteId) : null;
  return `
    <div class="task-row${task.done ? ' is-done' : ''}" data-task-id="${task.id}">
      <button class="task-row__check" data-task-toggle="${task.id}" type="button" aria-label="Отметить выполненной">${task.done ? '✓' : ''}</button>
      <div style="flex:1">
        <div class="task-row__text">${escapeHtml(task.text)}</div>
        ${note ? `<div class="task-row__meta">из заметки #${String(note.number).padStart(4, '0')}</div>` : ''}
      </div>
      <button class="task-row__del" data-task-del="${task.id}" type="button" aria-label="Удалить">✕</button>
    </div>`;
}

// компактная карточка дневниковой записи — используется в общей ленте «Все»
function renderJournalCompactHTML(entry) {
  const d = new Date(entry.date);
  const mood = MOODS.find((m) => m.id === entry.mood);
  const preview = entry.text.length > 70 ? entry.text.slice(0, 70).trim() + '…' : entry.text;
  return `
    <article class="note-card" style="--cat-color:#FF8A3D" data-journal-date="${entry.date}">
      <span class="note-card__cat">Дневник${mood ? ' ' + mood.emoji : ''}</span>
      <h3 class="note-card__title">${escapeHtml(d.toLocaleDateString('ru-RU', { day: '2-digit', month: 'long' }))}</h3>
      <p class="note-card__body">${escapeHtml(preview)}</p>
    </article>`;
}

// подробная карточка дневниковой записи — используется в истории на вкладке «Дневник»
function renderJournalEntryHTML(entry) {
  const d = new Date(entry.date);
  const mood = MOODS.find((m) => m.id === entry.mood);
  return `
    <div class="journal-entry">
      <div class="journal-entry__head">
        <span class="journal-entry__date">${d.toLocaleDateString('ru-RU', { day: '2-digit', month: 'long' })}</span>
        <span>${mood ? mood.emoji : ''}</span>
      </div>
      <div class="journal-entry__text">${escapeHtml(entry.text)}</div>
      ${entry.aiSummary ? `<div class="journal-entry__ai">✨ ${escapeHtml(entry.aiSummary)}</div>` : ''}
    </div>`;
}

function renderFeedItemHTML(item) {
  if (item.type === 'note') return renderNoteCardHTML(item.data);
  if (item.type === 'task') return renderTaskRowHTML(item.data);
  if (item.type === 'journal') return renderJournalCompactHTML(item.data);
  return '';
}

// ------------------------------------------------------------------- RECORDS (объединённая вкладка)
function getMergedFeed() {
  const notes = Storage.getNotes().map((n) => ({ type: 'note', ts: n.updatedAt, data: n }));
  const tasks = Storage.getTasks().map((t) => ({ type: 'task', ts: t.createdAt, data: t }));
  const journal = Storage.getJournal().map((j) => ({ type: 'journal', ts: j.updatedAt || j.createdAt, data: j }));
  return [...notes, ...tasks, ...journal].sort((a, b) => b.ts - a.ts);
}

function matchesQuery(q) {
  return (item) => {
    if (item.type === 'note') return (item.data.title + ' ' + item.data.body + ' ' + (item.data.tags || []).join(' ')).toLowerCase().includes(q);
    if (item.type === 'task') return item.data.text.toLowerCase().includes(q);
    if (item.type === 'journal') return item.data.text.toLowerCase().includes(q);
    return false;
  };
}

function setRecordsFilter(filter) {
  state.recordsFilter = filter;
  $all('#recordsTypeSeg [data-rtype]').forEach((b) => b.classList.toggle('is-active', b.dataset.rtype === filter));
  $('#btnNewNote').hidden = (filter === 'tasks' || filter === 'journal');
  renderRecordsScreen();
}

function setRecordsView(view) {
  state.recordsView = view;
  $('#recordsListWrap').hidden = view === 'map';
  $('#recordsMapWrap').hidden = view !== 'map';
  $('#btnToggleMapView').classList.toggle('is-active', view === 'map');
  if (view === 'map') renderBrainMap();
}

function renderRecordsScreen() {
  const filter = state.recordsFilter;

  $('#journalComposer').hidden = filter !== 'journal';
  $('#insightCard').hidden = true;
  $('#journalHistoryHead').hidden = filter !== 'journal';
  $('#taskAddForm').hidden = filter !== 'tasks';
  $('#btnScanNotesForTasks').hidden = filter !== 'tasks';
  $('#tasksStatusChips').hidden = filter !== 'tasks';

  if (filter === 'journal') {
    renderJournalComposer();
    renderJournalHistoryList();
    return;
  }
  if (filter === 'tasks') {
    renderTasksList();
    return;
  }
  renderNotesOrAllList(filter);
}

function renderNotesOrAllList(filter) {
  const q = state.recordsQuery.trim().toLowerCase();
  let items = filter === 'all'
    ? getMergedFeed()
    : Storage.getNotes().map((n) => ({ type: 'note', ts: n.updatedAt, data: n }));

  if (q) items = items.filter(matchesQuery(q));
  if (filter === 'notes') items = items.sort((a, b) => (b.data.pinned - a.data.pinned) || (b.ts - a.ts));

  $('#recordsList').innerHTML = items.length
    ? items.map(renderFeedItemHTML).join('')
    : emptyStateHTML('Ничего не найдено. Попробуйте другой запрос или фильтр.');
}

function renderTasksList() {
  let tasks = Storage.getTasks();
  if (state.tasksFilter === 'open') tasks = tasks.filter((t) => !t.done);
  if (state.tasksFilter === 'done') tasks = tasks.filter((t) => t.done);
  const q = state.recordsQuery.trim().toLowerCase();
  if (q) tasks = tasks.filter((t) => t.text.toLowerCase().includes(q));
  $('#recordsList').innerHTML = tasks.length ? tasks.map(renderTaskRowHTML).join('') : emptyStateHTML('Здесь пока пусто.');
}

function renderJournalComposer() {
  const today = Storage.todayKey();
  const entry = Storage.getEntryByDate(today);
  $('#journalDate').textContent = new Date().toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
  $('#journalInput').value = entry ? entry.text : '';
  state.journalMood = entry ? entry.mood : null;
  renderMoodRow();

  const journal = Storage.getJournal();
  const withInsight = journal.find((e) => e.aiSummary);
  if (withInsight) {
    $('#insightCard').hidden = false;
    $('#insightText').textContent = withInsight.aiSummary;
  }
}

function renderJournalHistoryList() {
  const today = Storage.todayKey();
  let list = Storage.getJournal().filter((e) => e.date !== today);
  const q = state.recordsQuery.trim().toLowerCase();
  if (q) list = list.filter((e) => e.text.toLowerCase().includes(q));
  $('#recordsList').innerHTML = list.length
    ? list.map(renderJournalEntryHTML).join('')
    : emptyStateHTML('Записей пока нет — начните с сегодняшнего дня выше.');
}

function renderMoodRow() {
  $('#moodRow').innerHTML = MOODS.map(
    (m) => `<button type="button" class="mood-btn${state.journalMood === m.id ? ' is-active' : ''}" data-mood="${m.id}" title="${m.label}">${m.emoji}</button>`
  ).join('');
}

function bindRecords() {
  $('#recordsTypeSeg').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-rtype]');
    if (!btn) return;
    TG.haptic('selection');
    setRecordsFilter(btn.dataset.rtype);
  });

  $('#btnToggleMapView').addEventListener('click', () => {
    TG.haptic('selection');
    setRecordsView(state.recordsView === 'map' ? 'list' : 'map');
  });

  $('#recordsSearch').addEventListener('input', (e) => {
    state.recordsQuery = e.target.value;
    renderRecordsScreen();
  });

  $('#btnNewNote').addEventListener('click', () => openNoteModal(null));

  // клики по объединённому списку записей: заметки, задачи, дневник
  $('#recordsList').addEventListener('click', (e) => {
    const pinBtn = e.target.closest('[data-pin-toggle]');
    if (pinBtn) {
      e.stopPropagation();
      Storage.togglePinNote(pinBtn.dataset.pinToggle);
      TG.haptic('selection');
      renderRecordsScreen();
      renderHome();
      return;
    }
    const taskToggle = e.target.closest('[data-task-toggle]');
    if (taskToggle) {
      Storage.toggleTask(taskToggle.dataset.taskToggle);
      TG.haptic('light');
      renderRecordsScreen();
      renderHome();
      return;
    }
    const taskDel = e.target.closest('[data-task-del]');
    if (taskDel) {
      Storage.deleteTask(taskDel.dataset.taskDel);
      TG.haptic('warning');
      renderRecordsScreen();
      renderHome();
      return;
    }
    const journalItem = e.target.closest('[data-journal-date]');
    if (journalItem) {
      setRecordsFilter('journal');
      return;
    }
    const card = e.target.closest('.note-card');
    if (card && card.dataset.noteId) openNoteModal(card.dataset.noteId);
  });

  // ---- дневник (внутри вкладки «Записи») ----
  $('#moodRow').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-mood]');
    if (!btn) return;
    state.journalMood = state.journalMood === btn.dataset.mood ? null : btn.dataset.mood;
    renderMoodRow();
    TG.haptic('selection');
  });

  $('#btnJournalSave').addEventListener('click', () => {
    const text = $('#journalInput').value.trim();
    if (!text) { toast('Запись пуста'); return; }
    Storage.upsertJournalEntry({ text, mood: state.journalMood });
    TG.haptic('success');
    toast('Запись сохранена');
    renderRecordsScreen();
  });

  $('#btnJournalAI').addEventListener('click', async (e) => {
    const text = $('#journalInput').value.trim();
    if (!text) { toast('Сначала напишите пару строк о дне'); return; }
    await withBusy(e.currentTarget, async () => {
      try {
        const summary = await Together.summarizeDay(text, state.journalMood);
        Storage.upsertJournalEntry({ text, mood: state.journalMood });
        Storage.setJournalAISummary(Storage.todayKey(), summary);
        toast('Готово ✨');
        renderRecordsScreen();
      } catch (err) { handleError(err); }
    }, '✨ Думаю…');
  });

  $('#btnWeeklyInsight').addEventListener('click', async (e) => {
    const entries = Storage.getJournal().slice(0, 7);
    if (!entries.length) { toast('Пока недостаточно записей'); return; }
    await withBusy(e.currentTarget, async () => {
      try {
        const insight = await Together.weeklyInsight(entries);
        const list = $('#recordsList');
        const card = document.createElement('div');
        card.className = 'insight-card';
        card.style.marginBottom = '12px';
        card.innerHTML = `<div class="insight-card__label">Итог недели</div><div class="insight-card__text">${escapeHtml(insight)}</div>`;
        list.prepend(card);
      } catch (err) { handleError(err); }
    }, '✨ Анализирую…');
  });

  // ---- задачи (внутри вкладки «Записи») ----
  $('#taskAddForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#taskAddInput');
    const text = input.value.trim();
    if (!text) return;
    Storage.addTask({ text });
    input.value = '';
    TG.haptic('success');
    renderRecordsScreen();
    renderHome();
  });

  $all('#tasksStatusChips [data-taskfilter]').forEach((chip) => {
    chip.addEventListener('click', () => {
      state.tasksFilter = chip.dataset.taskfilter;
      $all('#tasksStatusChips [data-taskfilter]').forEach((c) => c.classList.toggle('is-active', c === chip));
      renderTasksList();
    });
  });
}

// ------------------------------------------------------------------- NOTE MODAL
function openNoteModal(noteId) {
  state.editingNoteId = noteId;
  state.extractedTasksBuffer = [];
  const modal = $('#noteModal');
  $('#noteAiOutput').hidden = true;
  $('#noteAiOutput').innerHTML = '';

  if (noteId) {
    const note = Storage.getNote(noteId);
    if (!note) return;
    $('#noteModalId').textContent = `#${String(note.number).padStart(4, '0')}`;
    $('#noteModalDate').textContent = fmtDate(note.updatedAt);
    $('#noteTitle').value = note.title || '';
    $('#noteBody').value = note.body || '';
    $('#noteCategory').value = note.category || 'idea';
    $('#noteTags').value = (note.tags || []).join(', ');
    $('#btnDeleteNote').hidden = false;
    $('#btnPinNote').classList.toggle('is-active', !!note.pinned);
  } else {
    $('#noteModalId').textContent = 'новая';
    $('#noteModalDate').textContent = '';
    $('#noteTitle').value = '';
    $('#noteBody').value = '';
    $('#noteCategory').value = 'idea';
    $('#noteTags').value = '';
    $('#btnDeleteNote').hidden = true;
    $('#btnPinNote').classList.remove('is-active');
  }
  modal.hidden = false;
}

function closeNoteModal() {
  $('#noteModal').hidden = true;
  state.editingNoteId = null;
}

function currentNoteFieldsValid() {
  return $('#noteBody').value.trim().length > 0;
}

function refreshAfterNoteChange() {
  renderHome();
  if (state.view === 'records') renderRecordsScreen();
}

function bindNoteModal() {
  $('#noteModalClose').addEventListener('click', closeNoteModal);
  $('#noteModal').addEventListener('click', (e) => { if (e.target.id === 'noteModal') closeNoteModal(); });

  $('#btnPinNote').addEventListener('click', () => {
    if (!state.editingNoteId) { toast('Сначала сохраните заметку'); return; }
    const note = Storage.togglePinNote(state.editingNoteId);
    if (note) {
      $('#btnPinNote').classList.toggle('is-active', note.pinned);
      TG.haptic('selection');
      toast(note.pinned ? 'Закреплено' : 'Открепление');
      refreshAfterNoteChange();
    }
  });

  $('#btnSaveNote').addEventListener('click', () => {
    if (!currentNoteFieldsValid()) { toast('Текст заметки пуст'); return; }
    const tags = $('#noteTags').value.split(',').map((t) => t.trim()).filter(Boolean);
    const payload = {
      title: $('#noteTitle').value,
      body: $('#noteBody').value,
      category: $('#noteCategory').value,
      tags,
    };
    if (state.editingNoteId) {
      Storage.updateNote(state.editingNoteId, payload);
      toast('Изменения сохранены');
    } else {
      const created = Storage.addNote(payload);
      state.editingNoteId = created.id;
      toast('Заметка добавлена');
    }
    TG.haptic('success');
    closeNoteModal();
    refreshAfterNoteChange();
  });

  $('#btnDeleteNote').addEventListener('click', async () => {
    if (!state.editingNoteId) return;
    const ok = await TG.showConfirm('Удалить эту заметку без возможности восстановления?');
    if (!ok) return;
    Storage.deleteNote(state.editingNoteId);
    TG.haptic('warning');
    toast('Заметка удалена');
    closeNoteModal();
    refreshAfterNoteChange();
  });

  // Одно действие вместо трёх: категория+теги+заголовок и задачи находятся
  // одним нажатием. Сжатие текста — отдельная, менее заметная ссылка ниже,
  // потому что она необратимо переписывает текст заметки.
  $('#btnAutoProcess').addEventListener('click', async (e) => {
    if (!currentNoteFieldsValid()) { toast('Сначала напишите текст заметки'); return; }
    await withBusy(e.currentTarget, async () => {
      try {
        const text = $('#noteBody').value;
        const [cat, tasks] = await Promise.all([
          Together.categorizeNote(text),
          Together.extractTasksFromText(text),
        ]);
        if (!$('#noteTitle').value.trim() && cat.title) $('#noteTitle').value = cat.title;
        $('#noteCategory').value = cat.category;
        $('#noteTags').value = cat.tags.join(', ');
        state.extractedTasksBuffer = tasks;

        const out = $('#noteAiOutput');
        out.innerHTML = tasks.length
          ? `<div style="margin-bottom:8px;font-weight:700">Разложено по полочкам ✓ · найдено задач: ${tasks.length}</div>
             <ul style="margin:0 0 10px;padding-left:18px;display:flex;flex-direction:column;gap:5px">
               ${tasks.map((t) => `<li>${escapeHtml(t.text)}</li>`).join('')}
             </ul>
             <button class="btn btn--brass btn--sm" id="btnAddAllTasks" type="button">Добавить все в задачи</button>`
          : `<div>Разложено по полочкам ✓. Явных задач в тексте не нашлось.</div>`;
        out.hidden = false;
        TG.haptic('success');
        toast('Готово ✨');
      } catch (err) { handleError(err); }
    }, '✨ Обрабатываю…');
  });

  $('#noteAiOutput').addEventListener('click', (e) => {
    if (e.target.id === 'btnAddAllTasks') {
      state.extractedTasksBuffer.forEach((t) => {
        Storage.addTask({ text: t.text, priority: t.priority || 'normal', sourceNoteId: state.editingNoteId });
      });
      toast(`Добавлено задач: ${state.extractedTasksBuffer.length}`);
      TG.haptic('success');
      $('#noteAiOutput').hidden = true;
      refreshAfterNoteChange();
    }
    if (e.target.id === 'btnUseSummary') {
      $('#noteBody').value = $('#noteAiOutput').dataset.summary || $('#noteBody').value;
      $('#noteAiOutput').hidden = true;
      toast('Текст заметки обновлён');
    }
  });

  $('#btnSummarizeNote').addEventListener('click', async (e) => {
    if (!currentNoteFieldsValid()) { toast('Сначала напишите текст заметки'); return; }
    await withBusy(e.currentTarget, async () => {
      try {
        const summary = await Together.summarizeText($('#noteBody').value);
        const out = $('#noteAiOutput');
        out.innerHTML = `
          <div style="margin-bottom:8px;font-weight:700">Кратко:</div>
          <div style="margin-bottom:10px">${escapeHtml(summary)}</div>
          <button class="btn btn--ghost btn--sm" id="btnUseSummary" type="button">Заменить текст заметки на это</button>`;
        out.dataset.summary = summary;
        out.hidden = false;
      } catch (err) { handleError(err); }
    }, '📝 Сжимаю…');
  });
}

// ------------------------------------------------------------------- CHAT
function renderChat() {
  const log = $('#chatLog');
  const messages = Storage.getChat();
  log.innerHTML = messages.length
    ? messages.map(renderChatMessageHTML).join('')
    : emptyStateHTML('Спросите что-нибудь о своих заметках — например «что я думал о смене работы?» или «собери мои идеи для проекта X».');
  log.scrollTop = log.scrollHeight;
}

function renderChatMessageHTML(msg) {
  const sourcesHTML = msg.sources && msg.sources.length
    ? `<div class="msg__sources">${msg.sources.map((s) => `<span class="msg__source-chip" data-open-note="${s.id}">#${String(s.number).padStart(4, '0')} ${escapeHtml((s.title || '').slice(0, 18))}</span>`).join('')}</div>`
    : '';
  return `
    <div class="msg msg--${msg.role === 'ai' ? 'ai' : 'user'}">
      <div class="msg__bubble">${escapeHtml(msg.content)}</div>
      ${sourcesHTML}
    </div>`;
}

function bindChat() {
  const input = $('#chatInput');
  input.addEventListener('input', () => autoGrow(input));

  $('#chatForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (state.chatSending) return;
    const text = input.value.trim();
    if (!text) return;

    Storage.addChatMessage({ role: 'user', content: text });
    input.value = '';
    autoGrow(input);
    renderChat();

    state.chatSending = true;
    $('#chatSend').disabled = true;
    const log = $('#chatLog');
    log.insertAdjacentHTML('beforeend', `<div class="msg msg--ai msg--typing" id="typingIndicator"><div class="msg__bubble"><span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span></div></div>`);
    log.scrollTop = log.scrollHeight;

    try {
      const history = Storage.getChat();
      const { reply, sources } = await Together.ragChat(text, history);
      Storage.addChatMessage({ role: 'ai', content: reply, sources });
      TG.haptic('light');
    } catch (err) {
      Storage.addChatMessage({ role: 'ai', content: '⚠️ ' + (err.message || 'Ошибка запроса к ИИ') });
      TG.haptic('error');
    } finally {
      state.chatSending = false;
      $('#chatSend').disabled = false;
      $('#typingIndicator')?.remove();
      renderChat();
    }
  });

  $('#chatLog').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-open-note]');
    if (chip) openNoteModal(chip.dataset.openNote);
  });

  $('#btnClearChat').addEventListener('click', async () => {
    const ok = await TG.showConfirm('Очистить историю чата?');
    if (!ok) return;
    Storage.clearChat();
    renderChat();
  });
}

// ------------------------------------------------------------------- PROFILE (статистика + настройки)
function renderProfile() {
  const stats = Storage.getStats();
  $('#statsGrid').innerHTML = `
    <div class="stat-card"><div class="stat-card__top"><span class="stat-card__label">Заметок</span></div><div class="stat-card__value">${stats.notesCount}</div></div>
    <div class="stat-card stat-card--accent"><div class="stat-card__top"><span class="stat-card__label">Задач выполнено</span></div><div class="stat-card__value">${stats.tasksDone}<span class="stat-card__unit">/${stats.tasksDone + stats.tasksOpen}</span></div></div>
    <div class="stat-card"><div class="stat-card__top"><span class="stat-card__label">Серия дней</span></div><div class="stat-card__value">${stats.streak}<span class="stat-card__unit">🔥</span></div></div>
    <div class="stat-card"><div class="stat-card__top"><span class="stat-card__label">Слов написано</span></div><div class="stat-card__value">${stats.wordsWritten}</div></div>
  `;
  renderActivityChart();

  const s = Storage.getSettings();
  $('#settingsApiKey').value = s.apiKey || '';
  $('#settingsModel').value = s.model || '';
  $('#settingsUserName').value = s.userName || '';
  $('#apiTestStatus').textContent = '';
  $('#apiTestStatus').className = 'settings-status';
}

// -------- считаем "корзины" для графика активности в зависимости от диапазона
function computeBuckets(range) {
  const notes = Storage.getNotes();
  const now = new Date();

  if (range === 'week') {
    const labels = [];
    const counts = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now); d.setDate(now.getDate() - i); d.setHours(0, 0, 0, 0);
      const next = new Date(d); next.setDate(d.getDate() + 1);
      labels.push(WEEKDAYS_SHORT[d.getDay()]);
      counts.push(notes.filter((n) => n.createdAt >= d.getTime() && n.createdAt < next.getTime()).length);
    }
    return { labels, counts, subLabel: 'заметок за 7 дней' };
  }

  if (range === 'month') {
    const labels = [];
    const counts = [];
    for (let b = 5; b >= 0; b--) {
      const end = new Date(now); end.setDate(now.getDate() - b * 5); end.setHours(23, 59, 59, 999);
      const start = new Date(end); start.setDate(end.getDate() - 4); start.setHours(0, 0, 0, 0);
      labels.push(`${start.getDate()}–${end.getDate()}`);
      counts.push(notes.filter((n) => n.createdAt >= start.getTime() && n.createdAt <= end.getTime()).length);
    }
    return { labels, counts, subLabel: 'заметок за 30 дней' };
  }

  if (range === 'all') {
    const years = Storage.getAvailableYears().sort((a, b) => a - b);
    const counts = years.map((y) => notes.filter((n) => new Date(n.createdAt).getFullYear() === y).length);
    return { labels: years.map(String), counts, subLabel: 'заметок по годам' };
  }

  // year (по умолчанию)
  const year = now.getFullYear();
  const counts = Storage.getMonthlyNoteCounts(year);
  return { labels: MONTHS_SHORT, counts, subLabel: `заметок за ${year} год` };
}

// Простой, читаемый столбчатый график.
function buildChartSVG(labels, counts) {
  const W = 320, H = 148, padL = 4, padR = 4, padB = 20, padT = 18;
  const chartW = W - padL - padR;
  const chartH = H - padT - padB;
  const n = counts.length;
  const maxCount = Math.max(1, ...counts);
  const slot = chartW / n;
  const barW = Math.max(6, Math.min(28, slot * 0.56));
  const showLabels = n <= 12;

  let bars = '';
  counts.forEach((c, i) => {
    const cx = padL + slot * i + slot / 2;
    const barH = c > 0 ? Math.max(4, (c / maxCount) * chartH) : 2;
    const y = padT + (chartH - barH);
    const isLast = i === n - 1;
    const color = c > 0 ? (isLast ? 'var(--accent)' : 'var(--surface-2)') : 'var(--surface)';
    bars += `<rect x="${(cx - barW / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" rx="${Math.min(6, barW / 2).toFixed(1)}" fill="${color}"></rect>`;
    if (c > 0) {
      bars += `<text class="chart-bar-value" x="${cx.toFixed(1)}" y="${(y - 6).toFixed(1)}" text-anchor="middle">${c}</text>`;
    }
    if (showLabels) {
      bars += `<text class="chart-bar-label" x="${cx.toFixed(1)}" y="${H - 5}" text-anchor="middle">${escapeHtml(String(labels[i]))}</text>`;
    }
  });

  return `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">${bars}</svg>`;
}

const RANGE_SUBLABELS = {
  week: 'за 7 дней', month: 'за 30 дней', year: `за ${new Date().getFullYear()} год`, all: 'по годам',
};

function renderActivityChart() {
  const { labels, counts } = computeBuckets(state.profileRange);
  const total = counts.reduce((a, b) => a + b, 0);
  $('#chartTotalLabel').innerHTML = `${total}<small>${total === 1 ? 'заметка' : 'заметок'}</small>`;
  $('#chartSubLabel').textContent = RANGE_SUBLABELS[state.profileRange] || '';
  $('#chartMount').innerHTML = total > 0
    ? buildChartSVG(labels, counts)
    : `<div class="chart-empty">Пока нет данных — добавьте пару заметок, и здесь появится график 📝</div>`;
}

function bindProfileRange() {
  $('#profileRange').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-range]');
    if (!btn) return;
    state.profileRange = btn.dataset.range;
    $all('#profileRange [data-range]').forEach((b) => b.classList.toggle('is-active', b === btn));
    TG.haptic('selection');
    renderActivityChart();
  });
}

function readSettingsForm() {
  return {
    apiKey: $('#settingsApiKey').value.trim(),
    model: $('#settingsModel').value.trim(),
    userName: $('#settingsUserName').value.trim(),
  };
}

function bindSettings() {
  bindProfileRange();

  $('#btnToggleKey').addEventListener('click', () => {
    const input = $('#settingsApiKey');
    input.type = input.type === 'password' ? 'text' : 'password';
  });

  $('#btnSaveSettings').addEventListener('click', () => {
    Storage.saveSettings(readSettingsForm());
    TG.haptic('success');
    toast('Настройки сохранены');
  });

  $('#btnTestApi').addEventListener('click', async (e) => {
    Storage.saveSettings(readSettingsForm());
    const status = $('#apiTestStatus');
    await withBusy(e.currentTarget, async () => {
      try {
        await Together.testConnection();
        status.textContent = '✓ Подключение работает';
        status.className = 'settings-status is-ok';
        TG.haptic('success');
      } catch (err) {
        status.textContent = '✕ ' + (err.message || 'Ошибка подключения');
        status.className = 'settings-status is-err';
        TG.haptic('error');
      }
    }, 'Проверяю…');
  });

  $('#btnShowOnboarding').addEventListener('click', () => {
    showOnboarding();
  });

  $('#btnExport').addEventListener('click', () => {
    const data = Storage.exportAll();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `second-brain-export-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast('Экспортировано');
  });

  $('#importFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      Storage.importAll(data);
      toast('Данные импортированы');
      TG.haptic('success');
      renderHome();
      renderRecordsScreen();
      renderProfile();
    } catch (err) {
      handleError(err, 'Не удалось прочитать файл');
    } finally {
      e.target.value = '';
    }
  });

  $('#btnClearAll').addEventListener('click', async () => {
    const ok = await TG.showConfirm('Удалить ВСЕ данные (заметки, задачи, дневник, чат)? Это необратимо.');
    if (!ok) return;
    Storage.clearAllData();
    TG.haptic('warning');
    location.reload();
  });
}

// ------------------------------------------------------------------- PICKER (найти задачи в заметках)
function openPickerModal() {
  const notes = Storage.getNotes();
  $('#pickerList').innerHTML = notes.length
    ? notes.map(renderNoteCardHTML).join('')
    : emptyStateHTML('Сначала добавьте хотя бы одну заметку.');
  $('#pickerModal').hidden = false;
}

function bindPicker() {
  $('#btnScanNotesForTasks').addEventListener('click', openPickerModal);

  $('#pickerList').addEventListener('click', async (e) => {
    if (e.target.closest('[data-pin-toggle]')) return;
    const card = e.target.closest('.note-card');
    if (!card) return;
    const note = Storage.getNote(card.dataset.noteId);
    if (!note) return;
    card.style.opacity = '.5';
    try {
      const tasks = await Together.extractTasksFromText(note.body);
      if (!tasks.length) {
        toast('В этой заметке явных задач не нашлось');
      } else {
        tasks.forEach((t) => Storage.addTask({ text: t.text, priority: t.priority || 'normal', sourceNoteId: note.id }));
        toast(`Добавлено задач: ${tasks.length}`);
        TG.haptic('success');
      }
      $('#pickerModal').hidden = true;
      renderRecordsScreen();
      renderHome();
    } catch (err) {
      handleError(err);
      card.style.opacity = '1';
    }
  });

  $('#pickerModalClose').addEventListener('click', () => { $('#pickerModal').hidden = true; });
  $('#pickerModal').addEventListener('click', (e) => { if (e.target.id === 'pickerModal') $('#pickerModal').hidden = true; });
}

// ------------------------------------------------------------------- BRAIN MAP (карта мыслей / нейросвязи)
// Рисуем заметки как "нейроны": положение по оси X — дата создания,
// по оси Y — категория (полоса), связи — между заметками с общими тегами.
// Работает целиком на фронтенде, без бэкенда и без эмбеддингов. Теперь это
// просто альтернативный вид вкладки «Записи», а не отдельная модалка.
function buildBrainSVG() {
  const notes = [...Storage.getNotes()].sort((a, b) => a.createdAt - b.createdAt);
  const W = 340, H = 460, padX = 26, padTop = 20, padBottom = 20;

  const usedCatIds = Array.from(new Set(notes.map((n) => n.category)));
  const bandH = (H - padTop - padBottom) / Math.max(1, usedCatIds.length);

  const minTs = notes[0]?.createdAt ?? Date.now();
  const maxTs = notes[notes.length - 1]?.createdAt ?? Date.now();
  const span = Math.max(1, maxTs - minTs);

  const pos = {};
  notes.forEach((n) => {
    const bandIdx = usedCatIds.indexOf(n.category);
    const x = padX + ((n.createdAt - minTs) / span) * (W - padX * 2);
    const jitter = hash01(n.id);
    const y = padTop + bandIdx * bandH + bandH * (0.25 + jitter * 0.5);
    pos[n.id] = { x, y, note: n };
  });

  // связи: заметки, у которых есть общий тег, соединяем цепочкой (по дате)
  const tagGroups = {};
  notes.forEach((n) => (n.tags || []).forEach((t) => {
    if (!tagGroups[t]) tagGroups[t] = [];
    tagGroups[t].push(n.id);
  }));
  const linkSet = new Set();
  Object.values(tagGroups).forEach((ids) => {
    if (ids.length < 2) return;
    for (let i = 0; i < ids.length - 1; i++) {
      const key = [ids[i], ids[i + 1]].sort().join('|');
      linkSet.add(key);
    }
  });

  let linksHTML = '';
  linkSet.forEach((key) => {
    const [id1, id2] = key.split('|');
    const p1 = pos[id1], p2 = pos[id2];
    if (!p1 || !p2) return;
    const midX = (p1.x + p2.x) / 2;
    const curve = (hash01(key) - 0.5) * 40;
    linksHTML += `<path class="brain-link" d="M ${p1.x.toFixed(1)} ${p1.y.toFixed(1)} Q ${midX.toFixed(1)} ${(Math.min(p1.y, p2.y) - 18 + curve).toFixed(1)} ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}" fill="none"/>`;
  });

  let nodesHTML = '';
  notes.forEach((n) => {
    const p = pos[n.id];
    const cat = Storage.categoryById(n.category);
    const r = 5 + Math.min(3, (n.tags || []).length) + (n.pinned ? 2 : 0);
    const dur = (2.4 + hash01(n.id + 'd') * 2.2).toFixed(2);
    const delay = (hash01(n.id + 't') * 2).toFixed(2);
    const label = escapeHtml((n.title || n.body).slice(0, 24));
    nodesHTML += `
      <g class="brain-node" data-note-id="${n.id}" style="animation: nodePulse ${dur}s ease-in-out ${delay}s infinite;">
        <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${(r + 5).toFixed(1)}" fill="${cat.color}" opacity="0.12"></circle>
        <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r.toFixed(1)}" fill="${cat.color}" stroke="#0A0A0C" stroke-width="1"></circle>
        <title>${label}</title>
      </g>`;
  });

  return {
    svg: `<svg class="brain-svg" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">${linksHTML}${nodesHTML}</svg>`,
    noteCount: notes.length,
    linkCount: linkSet.size,
    usedCatIds,
  };
}

function renderBrainMap() {
  const wrap = $('#brainCanvasWrap');
  const notes = Storage.getNotes();
  if (!notes.length) {
    wrap.innerHTML = `<div class="brain-empty">Пока нет заметок для карты мыслей.<br>Добавьте несколько заметок с тегами — и здесь появятся связи между ними, как нейроны в мозге 🧠</div>`;
    $('#brainLegend').innerHTML = '';
    $('#brainStats').textContent = '';
    return;
  }
  const { svg, noteCount, linkCount, usedCatIds } = buildBrainSVG();
  wrap.innerHTML = svg;

  const categories = Storage.getCategories();
  $('#brainLegend').innerHTML = usedCatIds
    .map((id) => {
      const c = categories.find((cat) => cat.id === id);
      if (!c) return '';
      return `<span class="brain-legend__item"><span class="brain-legend__dot" style="background:${c.color}"></span>${escapeHtml(c.label)}</span>`;
    })
    .join('');
  $('#brainStats').textContent = `${noteCount} заметок · ${linkCount} связей по общим тегам`;
}

function bindBrain() {
  $('#brainCanvasWrap').addEventListener('click', (e) => {
    const node = e.target.closest('.brain-node');
    if (!node) return;
    const noteId = node.dataset.noteId;
    setRecordsView('list');
    openNoteModal(noteId);
  });
}

// ------------------------------------------------------------------- ONBOARDING (мини-обучалка)
const ONBOARDING_SLIDES = [
  {
    icon: '🧠',
    title: 'Добро пожаловать во «Второй мозг»',
    text: 'Это личная база знаний с ИИ: записывайте мысли, а приложение само разложит их по полочкам, найдёт задачи и поможет всё вспомнить.',
  },
  {
    icon: '✍️',
    title: 'Быстрый захват мыслей',
    text: 'Главный экран — это только поле «Запишите мысль…» и свежая лента. Ничего лишнего: остальное — на соседних вкладках.',
  },
  {
    icon: '🗂️',
    title: 'Записи — всё в одном месте',
    text: 'Заметки, дневник и задачи живут на одной вкладке «Записи». Переключатель сверху фильтрует ленту, а значок 🧠 показывает её же как карту мыслей.',
  },
  {
    icon: '✨',
    title: 'Один клик — и заметка разобрана',
    text: 'Откройте заметку и нажмите «Обработать заметку» — модель сама подберёт категорию, теги, заголовок и найдёт в тексте задачи. Всё за одно нажатие.',
  },
  {
    icon: '💬',
    title: 'Чат с собственными заметками',
    text: 'На вкладке «ИИ-чат» можно спрашивать что угодно о своих записях — ИИ найдёт релевантные заметки (RAG) и ответит с указанием источников.',
  },
  {
    icon: '📊',
    title: 'Профиль',
    text: 'Статистика, график активности, серия дней и все настройки — на вкладке «Профиль». Заходите туда, когда интересна аналитика.',
  },
  {
    icon: '🔑',
    title: 'Один шаг перед стартом',
    text: 'ИИ-функции работают через Together AI — добавьте свой бесплатный API-ключ в Профиле, и всё заработает. Без ключа заметки и задачи всё равно можно вести.',
  },
];

let onboardingIndex = 0;

function buildOnboardingSlides() {
  $('#onboardingTrack').innerHTML = ONBOARDING_SLIDES.map((s) => `
    <div class="onboarding__slide">
      <div class="onboarding__icon">${s.icon}</div>
      <h2 class="onboarding__title">${escapeHtml(s.title)}</h2>
      <p class="onboarding__text">${escapeHtml(s.text)}</p>
    </div>`).join('');
  $('#onboardingDots').innerHTML = ONBOARDING_SLIDES.map((_, i) => `<span class="onboarding__dot${i === 0 ? ' is-active' : ''}"></span>`).join('');
}

function updateOnboardingSlide() {
  const track = $('#onboardingTrack');
  track.style.transform = `translateX(-${onboardingIndex * 100}%)`;
  $all('.onboarding__dot').forEach((d, i) => d.classList.toggle('is-active', i === onboardingIndex));
  $('#onboardingNext').textContent = onboardingIndex === ONBOARDING_SLIDES.length - 1 ? 'Начать' : 'Далее';
}

function showOnboarding() {
  onboardingIndex = 0;
  buildOnboardingSlides();
  updateOnboardingSlide();
  $('#onboarding').hidden = false;
}

function finishOnboarding() {
  Storage.setOnboarded(true);
  $('#onboarding').hidden = true;
}

function bindOnboarding() {
  $('#onboardingNext').addEventListener('click', () => {
    if (onboardingIndex < ONBOARDING_SLIDES.length - 1) {
      onboardingIndex += 1;
      updateOnboardingSlide();
      TG.haptic('selection');
    } else {
      finishOnboarding();
      TG.haptic('success');
    }
  });
  $('#onboardingSkip').addEventListener('click', () => {
    finishOnboarding();
  });
}

// ------------------------------------------------------------------- BOOTSTRAP
function init() {
  TG.init();
  fillCategorySelects();
  bindNav();
  bindHome();
  bindRecords();
  bindNoteModal();
  bindChat();
  bindSettings();
  bindPicker();
  bindBrain();
  bindOnboarding();
  switchView('home');

  if (!Storage.isOnboarded()) {
    showOnboarding();
  }

  if (!TG.isTelegram()) {
    console.info('[Второй мозг] Запущено вне Telegram — интеграция WebApp отключена, это нормально для разработки.');
  }
}

document.addEventListener('DOMContentLoaded', init);
