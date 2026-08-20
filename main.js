// =============================================================================
// main.js — точка входа. Состояние приложения, рендер экранов, обработчики.
//
// Структура экранов (после редизайна по UX-аудиту):
//   Главная — только захват мысли + 4 последние записи
//   Записи  — единая лента: заметки + задачи + дневник, с фильтром сверху,
//             плюс переключатель "Список / Карта мыслей"
//   ИИ-чат  — без изменений
//   Профиль — статистика, график активности, серия дней, настройки
// =============================================================================

import { Storage } from './storage.js';
import { Together } from './together.js';
import { TG } from './telegram.js';

// ------------------------------------------------------------------- state
const state = {
  view: 'home',
  feedFilter: 'all',        // all | notes | tasks | journal
  feedMode: 'list',         // list | map
  feedQuery: '',
  notesFilter: { category: 'all' },
  tasksFilter: 'open',
  editingNoteId: null,      // null = создаём новую заметку
  journalMood: null,
  chatSending: false,
  extractedTasksBuffer: [], // временный буфер результатов "Обработать заметку"
  homeRange: 'week',
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

function emptyState(msg) {
  return `<div class="empty-state">${msg}</div>`;
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

function renderFeedCategoryChips() {
  const cats = Storage.getCategories();
  const wrap = $('#feedCategoryChips');
  const chips = [{ id: 'all', label: 'Все категории' }, ...cats.map((c) => ({ id: c.id, label: c.label }))];
  wrap.innerHTML = chips
    .map((c) => `<button class="chip${state.notesFilter.category === c.id ? ' is-active' : ''}" data-catfilter="${c.id}" type="button">${escapeHtml(c.label)}</button>`)
    .join('');
}

// ------------------------------------------------------------------- navigation
// Единственная система навигации — нижняя панель (4 вкладки). Карта мыслей и
// настройки больше не дублируют её отдельными иконками в шапке.
function switchView(view) {
  state.view = view;
  $all('.view').forEach((v) => v.classList.toggle('is-active', v.dataset.view === view));
  $all('.tabbar__item').forEach((b) => b.classList.toggle('is-active', b.dataset.nav === view));
  const subtitles = {
    home: 'каталог мыслей',
    feed: 'заметки, задачи и дневник — одной лентой',
    chat: 'разговор с базой знаний',
    profile: 'статистика и настройки',
  };
  $('#topbarSubtitle').textContent = subtitles[view] || '';

  if (view === 'home') renderHome();
  if (view === 'feed') renderFeed();
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
// Единственная задача главного экрана — быстрый захват мысли. Никакой
// статистики/графиков здесь больше нет (см. вкладку "Профиль").
function renderHome() {
  const recent = [...Storage.getNotes()].sort((a, b) => (b.pinned - a.pinned) || (b.updatedAt - a.updatedAt)).slice(0, 4);
  $('#homeRecent').innerHTML = recent.length
    ? recent.map(renderNoteCardHTML).join('')
    : emptyState('Пока пусто. Запишите первую мысль выше — я разложу её по полочкам.');
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

  $('#btnHomeAll').addEventListener('click', () => {
    state.feedFilter = 'all';
    syncFeedTypeChipsUI();
    switchView('feed');
  });
}

// ------------------------------------------------------------------- CARD RENDERERS (общие)
// В списках заметка показывает только заголовок + первую строку + одну
// цветную метку категории — номер, теги и дата спрятаны до открытия карточки.
function renderNoteCardHTML(note) {
  const cat = Storage.categoryById(note.category);
  const title = note.title || (note.body.length > 46 ? note.body.slice(0, 46).trim() + '…' : note.body);
  const bodyPreview = note.title ? note.body : '';
  return `
    <article class="note-card${note.pinned ? ' is-pinned' : ''}" style="--cat-color:${cat.color}" data-note-id="${note.id}">
      <button class="note-card__pin${note.pinned ? ' is-active' : ''}" data-pin-toggle="${note.id}" type="button" aria-label="Закрепить" title="Закрепить">📌</button>
      <div class="note-card__top">
        <span class="note-card__cat">${escapeHtml(cat.label)}</span>
      </div>
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

// ------------------------------------------------------------------- FEED (единая лента)
function syncFeedTypeChipsUI() {
  $all('#feedTypeChips [data-typefilter]').forEach((b) => b.classList.toggle('is-active', b.dataset.typefilter === state.feedFilter));
}

function renderFeed() {
  const isNotes = state.feedFilter === 'notes';
  const isTasks = state.feedFilter === 'tasks';
  const isJournal = state.feedFilter === 'journal';

  $('#feedCategoryChips').hidden = !isNotes;
  if (isNotes) renderFeedCategoryChips();

  $('#feedTaskTools').hidden = !isTasks;
  if (isTasks) {
    $all('[data-taskfilter]').forEach((c) => c.classList.toggle('is-active', c.dataset.taskfilter === state.tasksFilter));
  }

  $('#feedJournalToday').hidden = !isJournal;
  if (isJournal) renderJournalToday();

  const showMap = state.feedMode === 'map';
  $('#btnToggleMap').classList.toggle('is-active', showMap);
  $('#mapbtnIcon').textContent = showMap ? '📋' : '🧠';
  $('#btnToggleMap').title = showMap ? 'Показать список' : 'Карта мыслей';

  $('#feedList').hidden = showMap;
  $('#feedMapWrap').hidden = !showMap;
  $('#brainLegend').style.display = showMap ? '' : 'none';
  $('#brainStats').style.display = showMap ? '' : 'none';

  $('#btnNewNote').hidden = showMap || isTasks || isJournal;

  if (showMap) {
    renderFeedMap();
  } else {
    renderFeedList();
  }
}

function renderFeedList() {
  const q = state.feedQuery.trim().toLowerCase();
  const container = $('#feedList');

  if (state.feedFilter === 'notes') {
    let notes = Storage.getNotes();
    if (state.notesFilter.category !== 'all') notes = notes.filter((n) => n.category === state.notesFilter.category);
    if (q) notes = notes.filter((n) => (n.title + ' ' + n.body + ' ' + (n.tags || []).join(' ')).toLowerCase().includes(q));
    notes = [...notes].sort((a, b) => (b.pinned - a.pinned) || (b.updatedAt - a.updatedAt));
    container.innerHTML = notes.length ? notes.map(renderNoteCardHTML).join('') : emptyState('Ничего не найдено. Попробуйте другой запрос или категорию.');
    return;
  }

  if (state.feedFilter === 'tasks') {
    let tasks = Storage.getTasks();
    if (state.tasksFilter === 'open') tasks = tasks.filter((t) => !t.done);
    if (state.tasksFilter === 'done') tasks = tasks.filter((t) => t.done);
    if (q) tasks = tasks.filter((t) => t.text.toLowerCase().includes(q));
    container.innerHTML = tasks.length ? tasks.map(renderTaskRowHTML).join('') : emptyState('Здесь пока пусто.');
    return;
  }

  if (state.feedFilter === 'journal') {
    const today = Storage.todayKey();
    let entries = Storage.getJournal().filter((e) => e.date !== today);
    if (q) entries = entries.filter((e) => e.text.toLowerCase().includes(q));
    container.innerHTML = entries.length ? entries.map(renderJournalEntryHTML).join('') : emptyState('Записей пока нет — начните с сегодняшнего дня выше.');
    return;
  }

  // 'all' — единая хронологическая лента заметок, открытых задач и дневника
  const notes = Storage.getNotes()
    .filter((n) => !q || (n.title + ' ' + n.body + ' ' + (n.tags || []).join(' ')).toLowerCase().includes(q))
    .map((n) => ({ ts: n.updatedAt, html: renderNoteCardHTML(n) }));
  const tasks = Storage.getTasks()
    .filter((t) => !t.done)
    .filter((t) => !q || t.text.toLowerCase().includes(q))
    .map((t) => ({ ts: t.createdAt, html: renderTaskRowHTML(t) }));
  const journal = Storage.getJournal()
    .filter((e) => !q || e.text.toLowerCase().includes(q))
    .map((e) => ({ ts: e.updatedAt || e.createdAt, html: renderJournalEntryHTML(e) }));

  const items = [...notes, ...tasks, ...journal].sort((a, b) => b.ts - a.ts).slice(0, 40);
  container.innerHTML = items.length ? items.map((i) => i.html).join('') : emptyState('Пока пусто. Запишите первую мысль на Главной.');
}

function bindFeed() {
  $('#feedSearch').addEventListener('input', (e) => {
    state.feedQuery = e.target.value;
    if (state.feedMode === 'list') renderFeedList();
  });

  $('#feedTypeChips').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-typefilter]');
    if (!chip) return;
    state.feedFilter = chip.dataset.typefilter;
    syncFeedTypeChipsUI();
    TG.haptic('selection');
    renderFeed();
  });

  $('#feedCategoryChips').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-catfilter]');
    if (!chip) return;
    state.notesFilter.category = chip.dataset.catfilter;
    renderFeedCategoryChips();
    renderFeedList();
    TG.haptic('selection');
  });

  $('#btnToggleMap').addEventListener('click', () => {
    state.feedMode = state.feedMode === 'map' ? 'list' : 'map';
    TG.haptic('light');
    renderFeed();
  });

  // делегирование кликов: закрепление заметок, открытие заметки, чек/удаление задач —
  // одни и те же обработчики работают и в общей ленте, и в фильтрованных подсписках.
  function delegateFeedEvents(container, { afterChange } = {}) {
    container.addEventListener('click', (e) => {
      const pinBtn = e.target.closest('[data-pin-toggle]');
      if (pinBtn) {
        e.stopPropagation();
        Storage.togglePinNote(pinBtn.dataset.pinToggle);
        TG.haptic('selection');
        afterChange?.();
        renderHome();
        return;
      }
      const toggleBtn = e.target.closest('[data-task-toggle]');
      if (toggleBtn) {
        Storage.toggleTask(toggleBtn.dataset.taskToggle);
        TG.haptic('light');
        afterChange?.();
        renderHome();
        return;
      }
      const delBtn = e.target.closest('[data-task-del]');
      if (delBtn) {
        Storage.deleteTask(delBtn.dataset.taskDel);
        TG.haptic('warning');
        afterChange?.();
        renderHome();
        return;
      }
      const card = e.target.closest('.note-card');
      if (card) { openNoteModal(card.dataset.noteId); return; }
    });
  }
  delegateFeedEvents($('#feedList'), { afterChange: renderFeedList });
  delegateFeedEvents($('#homeRecent'), { afterChange: () => { if (state.view === 'feed') renderFeedList(); } });

  $('#feedMapWrap').addEventListener('click', (e) => {
    const node = e.target.closest('.brain-node');
    if (!node) return;
    openNoteModal(node.dataset.noteId);
  });

  $('#btnNewNote').addEventListener('click', () => openNoteModal(null));

  // ---- задачи ----
  $('#taskAddForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#taskAddInput');
    const text = input.value.trim();
    if (!text) return;
    Storage.addTask({ text });
    input.value = '';
    TG.haptic('success');
    renderFeedList();
    renderHome();
  });

  $all('[data-taskfilter]').forEach((chip) => {
    chip.addEventListener('click', () => {
      state.tasksFilter = chip.dataset.taskfilter;
      $all('[data-taskfilter]').forEach((c) => c.classList.toggle('is-active', c === chip));
      renderFeedList();
    });
  });

  $('#btnScanNotesForTasks').addEventListener('click', openPickerModal);

  // ---- дневник ----
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
    renderFeedList();
    renderHome();
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
        renderJournalToday();
        renderFeedList();
        renderHome();
      } catch (err) { handleError(err); }
    }, '✨ Думаю…');
  });

  $('#btnWeeklyInsight').addEventListener('click', async (e) => {
    const entries = Storage.getJournal().slice(0, 7);
    if (!entries.length) { toast('Пока недостаточно записей'); return; }
    await withBusy(e.currentTarget, async () => {
      try {
        const insight = await Together.weeklyInsight(entries);
        const list = $('#feedList');
        const card = document.createElement('div');
        card.className = 'insight-card';
        card.style.marginTop = '0';
        card.style.marginBottom = '12px';
        card.innerHTML = `<div class="insight-card__label">Итог недели</div><div class="insight-card__text">${escapeHtml(insight)}</div>`;
        list.prepend(card);
      } catch (err) { handleError(err); }
    }, '✨ Анализирую…');
  });
}

function renderJournalToday() {
  const today = Storage.todayKey();
  const entry = Storage.getEntryByDate(today);
  $('#journalDate').textContent = new Date().toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
  $('#journalInput').value = entry ? entry.text : '';
  state.journalMood = entry ? entry.mood : null;
  renderMoodRow();
}

function renderMoodRow() {
  $('#moodRow').innerHTML = MOODS.map(
    (m) => `<button type="button" class="mood-btn${state.journalMood === m.id ? ' is-active' : ''}" data-mood="${m.id}" title="${m.label}">${m.emoji}</button>`
  ).join('');
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
    $('#noteTitle').value = note.title || '';
    $('#noteBody').value = note.body || '';
    $('#noteCategory').value = note.category || 'idea';
    $('#noteTags').value = (note.tags || []).join(', ');
    $('#noteModalDate').textContent = `создано ${fmtDate(note.createdAt)} · изменено ${fmtDate(note.updatedAt)}`;
    $('#btnDeleteNote').hidden = false;
    $('#btnPinNote').classList.toggle('is-active', !!note.pinned);
  } else {
    $('#noteModalId').textContent = 'новая';
    $('#noteTitle').value = '';
    $('#noteBody').value = '';
    $('#noteCategory').value = 'idea';
    $('#noteTags').value = '';
    $('#noteModalDate').textContent = '';
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
  if (state.view === 'feed') {
    if (state.feedMode === 'map') renderFeedMap(); else renderFeedList();
  }
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

  // Единственная ИИ-кнопка: за один клик подбирает категорию/теги, ищет задачи
  // в тексте и предлагает краткое резюме — вместо трёх отдельных кнопок с выбором.
  $('#btnProcessNote').addEventListener('click', async (e) => {
    if (!currentNoteFieldsValid()) { toast('Сначала напишите текст заметки'); return; }
    const text = $('#noteBody').value;
    await withBusy(e.currentTarget, async () => {
      try {
        const [tagResult, taskResult, summary] = await Promise.all([
          Together.categorizeNote(text),
          Together.extractTasksFromText(text),
          Together.summarizeText(text),
        ]);

        if (!$('#noteTitle').value.trim() && tagResult.title) $('#noteTitle').value = tagResult.title;
        $('#noteCategory').value = tagResult.category;
        $('#noteTags').value = tagResult.tags.join(', ');
        state.extractedTasksBuffer = taskResult;

        let html = `<div style="margin-bottom:2px;font-weight:700">✨ Категория и теги подобраны</div>`;
        if (taskResult.length) {
          html += `
            <div style="margin:14px 0 6px;font-weight:700">Найдено задач: ${taskResult.length}</div>
            <ul style="margin:0 0 10px;padding-left:18px;display:flex;flex-direction:column;gap:5px">
              ${taskResult.map((t) => `<li>${escapeHtml(t.text)}</li>`).join('')}
            </ul>
            <button class="btn btn--ghost btn--sm" id="btnAddAllTasks" type="button">Добавить все в задачи</button>`;
        } else {
          html += `<div style="margin:14px 0 2px;color:var(--text-dim)">Явных задач в тексте не нашлось.</div>`;
        }
        html += `
          <div style="margin:16px 0 6px;font-weight:700">Кратко:</div>
          <div style="margin-bottom:10px">${escapeHtml(summary)}</div>
          <button class="btn btn--ghost btn--sm" id="btnUseSummary" type="button">Заменить текст заметки на это</button>`;

        const out = $('#noteAiOutput');
        out.innerHTML = html;
        out.dataset.summary = summary;
        out.hidden = false;
        TG.haptic('success');
        toast('Заметка обработана ✨');
      } catch (err) { handleError(err); }
    }, '🤖 Обрабатываю…');
  });

  $('#noteAiOutput').addEventListener('click', (e) => {
    if (e.target.id === 'btnAddAllTasks') {
      state.extractedTasksBuffer.forEach((t) => {
        Storage.addTask({ text: t.text, priority: t.priority || 'normal', sourceNoteId: state.editingNoteId });
      });
      toast(`Добавлено задач: ${state.extractedTasksBuffer.length}`);
      TG.haptic('success');
      e.target.remove();
      if (state.view === 'feed') renderFeedList();
      renderHome();
    }
    if (e.target.id === 'btnUseSummary') {
      $('#noteBody').value = $('#noteAiOutput').dataset.summary || $('#noteBody').value;
      toast('Текст заметки обновлён');
    }
  });
}

// ------------------------------------------------------------------- CHAT
function renderChat() {
  const log = $('#chatLog');
  const messages = Storage.getChat();
  log.innerHTML = messages.length
    ? messages.map(renderChatMessageHTML).join('')
    : emptyState('Спросите что-нибудь о своих заметках — например «что я думал о смене работы?» или «собери мои идеи для проекта X».');
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

// ------------------------------------------------------------------- PROFILE (статистика + активность + настройки)
function renderProfile() {
  const stats = Storage.getStats();
  const settings = Storage.getSettings();

  $('#profileName').textContent = settings.userName ? settings.userName : 'Второй мозг';
  $('#profileStreak').textContent = `серия: ${stats.streak} ${stats.streak === 1 ? 'день' : 'дней'} 🔥`;

  $('#statsGrid').innerHTML = `
    <div class="stat-card"><div class="stat-card__top"><span class="stat-card__label">Заметок</span></div><div class="stat-card__value">${stats.notesCount}</div></div>
    <div class="stat-card stat-card--accent"><div class="stat-card__top"><span class="stat-card__label">Задач выполнено</span></div><div class="stat-card__value">${stats.tasksDone}<span class="stat-card__unit">/${stats.tasksDone + stats.tasksOpen}</span></div></div>
    <div class="stat-card"><div class="stat-card__top"><span class="stat-card__label">Серия дней</span></div><div class="stat-card__value">${stats.streak}<span class="stat-card__unit">🔥</span></div></div>
    <div class="stat-card"><div class="stat-card__top"><span class="stat-card__label">Слов написано</span></div><div class="stat-card__value">${stats.wordsWritten}</div></div>
  `;

  const journal = Storage.getJournal();
  const withInsight = journal.find((e) => e.aiSummary);
  if (withInsight) {
    $('#insightCard').hidden = false;
    $('#insightText').textContent = withInsight.aiSummary;
  } else {
    $('#insightCard').hidden = true;
  }

  renderActivityChart();
}

// -------- буквенно считаем "корзины" для графика активности в зависимости от выбранного диапазона
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

// Простой, читаемый столбчатый график — без наложенных линий и лишних
// засечек. Каждый столбец подписан снизу, у ненулевых столбцов значение
// подписано сверху, чтобы график можно было понять с одного взгляда.
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
  const { labels, counts } = computeBuckets(state.homeRange);
  const total = counts.reduce((a, b) => a + b, 0);
  $('#chartTotalLabel').innerHTML = `${total}<small>${total === 1 ? 'заметка' : 'заметок'}</small>`;
  $('#chartSubLabel').textContent = RANGE_SUBLABELS[state.homeRange] || '';
  $('#chartMount').innerHTML = total > 0
    ? buildChartSVG(labels, counts)
    : `<div class="chart-empty">Пока нет данных — добавьте пару заметок, и здесь появится график 📝</div>`;
}

function bindProfile() {
  $('#homeRange').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-range]');
    if (!btn) return;
    state.homeRange = btn.dataset.range;
    $all('#homeRange [data-range]').forEach((b) => b.classList.toggle('is-active', b === btn));
    TG.haptic('selection');
    renderActivityChart();
  });

  $('#btnOpenSettings').addEventListener('click', () => openSettingsModal());
}

// ------------------------------------------------------------------- SETTINGS MODAL
// Настройки не сохраняются на каждое нажатие клавиши — только явной кнопкой
// «Сохранить настройки» (или кнопкой «Тест», которая сохраняет перед
// проверкой соединения). Так всегда понятно, применились изменения или нет.
function openSettingsModal() {
  const s = Storage.getSettings();
  $('#settingsApiKey').value = s.apiKey || '';
  $('#settingsModel').value = s.model || '';
  $('#settingsUserName').value = s.userName || '';
  $('#apiTestStatus').textContent = '';
  $('#apiTestStatus').className = 'settings-status';
  $('#settingsModal').hidden = false;
}
function closeSettingsModal() {
  $('#settingsModal').hidden = true;
}

function readSettingsForm() {
  return {
    apiKey: $('#settingsApiKey').value.trim(),
    model: $('#settingsModel').value.trim(),
    userName: $('#settingsUserName').value.trim(),
  };
}

function bindSettings() {
  $('#settingsModalClose').addEventListener('click', closeSettingsModal);
  $('#settingsModal').addEventListener('click', (e) => { if (e.target.id === 'settingsModal') closeSettingsModal(); });

  $('#btnToggleKey').addEventListener('click', () => {
    const input = $('#settingsApiKey');
    input.type = input.type === 'password' ? 'text' : 'password';
  });

  $('#btnSaveSettings').addEventListener('click', () => {
    Storage.saveSettings(readSettingsForm());
    TG.haptic('success');
    toast('Настройки сохранены');
    closeSettingsModal();
    if (state.view === 'profile') renderProfile();
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
    closeSettingsModal();
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
      if (state.view === 'feed') renderFeed();
      if (state.view === 'profile') renderProfile();
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
    : emptyState('Сначала добавьте хотя бы одну заметку.');
  $('#pickerModal').hidden = false;
}

function bindPicker() {
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
      renderFeedList();
      renderHome();
    } catch (err) {
      handleError(err);
      card.style.opacity = '1';
    }
  });
}

// ------------------------------------------------------------------- BRAIN MAP (карта мыслей / нейросвязи)
// Рисуем заметки как "нейроны": положение по оси X — дата создания,
// по оси Y — категория (полоса), связи — между заметками с общими тегами.
// Работает целиком на фронтенде, без бэкенда и без эмбеддингов. Теперь это
// не отдельная модалка за иконкой в шапке, а переключатель внутри "Записей".
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

function renderFeedMap() {
  const wrap = $('#feedMapWrap');
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
    text: 'Главный экран — это только поле «Запишите мысль…». Всё остальное (заметки, задачи, дневник) живёт на вкладке «Записи».',
  },
  {
    icon: '✨',
    title: 'ИИ помогает разложить по полочкам',
    text: 'Откройте заметку и нажмите «Обработать заметку» — одним кликом модель подберёт категорию и теги, найдёт задачи в тексте и предложит краткое резюме.',
  },
  {
    icon: '🗂️',
    title: 'Единая лента записей',
    text: 'На вкладке «Записи» заметки, задачи и дневник живут вместе — переключайтесь между ними фильтром сверху, ищите через поиск.',
  },
  {
    icon: '💬',
    title: 'Чат с собственными заметками',
    text: 'На вкладке «ИИ-чат» можно спрашивать что угодно о своих записях — ИИ найдёт релевантные заметки (RAG) и ответит с указанием источников.',
  },
  {
    icon: '🧠',
    title: 'Карта мыслей',
    text: 'На вкладке «Записи» есть переключатель 🧠 — он показывает заметки как нейроны: расположение по датам, связи по общим тегам.',
  },
  {
    icon: '📊',
    title: 'Профиль и статистика',
    text: 'Серия дней, график активности и настройки (включая API-ключ Together) теперь на вкладке «Профиль» — не мешают на главном экране.',
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
function bindModalBackdrops() {
  $('#pickerModalClose')?.addEventListener('click', () => { $('#pickerModal').hidden = true; });
  $('#pickerModal')?.addEventListener('click', (e) => { if (e.target.id === 'pickerModal') $('#pickerModal').hidden = true; });
}

function init() {
  TG.init();
  fillCategorySelects();
  bindNav();
  bindHome();
  bindFeed();
  bindNoteModal();
  bindChat();
  bindProfile();
  bindSettings();
  bindPicker();
  bindOnboarding();
  bindModalBackdrops();
  switchView('home');

  if (!Storage.isOnboarded()) {
    showOnboarding();
  }

  if (!TG.isTelegram()) {
    console.info('[Второй мозг] Запущено вне Telegram — интеграция WebApp отключена, это нормально для разработки.');
  }
}

document.addEventListener('DOMContentLoaded', init);
