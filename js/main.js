// =============================================================================
// main.js — точка входа. Состояние приложения, рендер экранов, обработчики.
// =============================================================================

import { Storage } from './storage.js';
import { Together } from './together.js';
import { TG } from './telegram.js';

// ------------------------------------------------------------------- state
const state = {
  view: 'home',
  notesFilter: { category: 'all', query: '' },
  tasksFilter: 'open',
  editingNoteId: null, // null = создаём новую заметку
  journalMood: null,
  chatSending: false,
  extractedTasksBuffer: [], // временный буфер результатов "найти задачи" в модалке заметки
};

const MOODS = [
  { id: 'bad', emoji: '😔', label: 'Тяжело' },
  { id: 'meh', emoji: '😕', label: 'Так себе' },
  { id: 'ok', emoji: '😐', label: 'Нормально' },
  { id: 'good', emoji: '🙂', label: 'Хорошо' },
  { id: 'great', emoji: '😄', label: 'Отлично' },
];

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

// ------------------------------------------------------------------- categories
function fillCategorySelects() {
  const cats = Storage.getCategories();
  const options = cats.map((c) => `<option value="${c.id}">${escapeHtml(c.label)}</option>`).join('');
  $('#captureCategory').innerHTML = options;
  $('#noteCategory').innerHTML = options;
}

function renderNotesFilterChips() {
  const cats = Storage.getCategories();
  const wrap = $('#notesFilterChips');
  const chips = [{ id: 'all', label: 'Все' }, ...cats.map((c) => ({ id: c.id, label: c.label }))];
  wrap.innerHTML = chips
    .map((c) => `<button class="chip${state.notesFilter.category === c.id ? ' is-active' : ''}" data-catfilter="${c.id}" type="button">${escapeHtml(c.label)}</button>`)
    .join('');
}

// ------------------------------------------------------------------- navigation
function switchView(view) {
  state.view = view;
  $all('.view').forEach((v) => v.classList.toggle('is-active', v.dataset.view === view));
  $all('.tabbar__item').forEach((b) => b.classList.toggle('is-active', b.dataset.nav === view));
  const subtitles = {
    home: 'каталог мыслей',
    notes: `${Storage.getNotes().length} записей`,
    chat: 'разговор с базой знаний',
    journal: 'ежедневная рефлексия',
    tasks: 'что нужно сделать',
  };
  $('#topbarSubtitle').textContent = subtitles[view] || '';

  if (view === 'home') renderHome();
  if (view === 'notes') renderNotesList();
  if (view === 'chat') renderChat();
  if (view === 'journal') renderJournal();
  if (view === 'tasks') renderTasks();
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
function renderHome() {
  updateApiBanner();
  const stats = Storage.getStats();
  $('#streakValue').textContent = stats.streak;

  $('#statsGrid').innerHTML = `
    <div class="stat-card"><div class="stat-card__value">${stats.notesCount}</div><div class="stat-card__label">заметок</div></div>
    <div class="stat-card"><div class="stat-card__value">${stats.tasksOpen}</div><div class="stat-card__label">задач открыто</div></div>
    <div class="stat-card"><div class="stat-card__value">${stats.journalDays}</div><div class="stat-card__label">дней в дневнике</div></div>
  `;

  const recent = Storage.getNotes().slice(0, 4);
  $('#homeRecent').innerHTML = recent.length
    ? recent.map(renderNoteCardHTML).join('')
    : `<div class="empty-state">Пока пусто. Запишите первую мысль выше — я разложу её по полочкам.</div>`;

  const openTasks = Storage.getTasks().filter((t) => !t.done).slice(0, 4);
  $('#homeTasks').innerHTML = openTasks.length
    ? openTasks.map(renderTaskRowHTML).join('')
    : `<div class="empty-state">Открытых задач нет — можно выдохнуть 🙂</div>`;

  // покажем последний ИИ-инсайт дня, если есть
  const journal = Storage.getJournal();
  const withInsight = journal.find((e) => e.aiSummary);
  if (withInsight) {
    $('#insightCard').hidden = false;
    $('#insightText').textContent = withInsight.aiSummary;
  } else {
    $('#insightCard').hidden = true;
  }
}

function updateApiBanner() {
  const hasKey = !!Storage.getSettings().apiKey;
  $('#apiBanner').hidden = hasKey;
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

  $('#btnStreak').addEventListener('click', () => {
    const s = Storage.getStreak();
    toast(s > 0 ? `Серия: ${s} ${s === 1 ? 'день' : 'дня подряд'} 🔥` : 'Начните серию — добавьте что-нибудь сегодня');
  });
}

// ------------------------------------------------------------------- NOTE CARD (общий рендер)
function renderNoteCardHTML(note) {
  const cat = Storage.categoryById(note.category);
  const title = note.title || (note.body.length > 46 ? note.body.slice(0, 46).trim() + '…' : note.body);
  const bodyPreview = note.title ? note.body : '';
  const tags = (note.tags || []).map((t) => `<span class="tag-pill">#${escapeHtml(t)}</span>`).join('');
  return `
    <article class="note-card" style="--cat-color:${cat.color}" data-note-id="${note.id}">
      <div class="note-card__top">
        <span class="note-card__cat">${escapeHtml(cat.label)}</span>
        <span class="note-card__id">#${String(note.number).padStart(4, '0')}</span>
      </div>
      <h3 class="note-card__title">${escapeHtml(title)}</h3>
      ${bodyPreview ? `<p class="note-card__body">${escapeHtml(bodyPreview)}</p>` : ''}
      ${tags ? `<div class="note-card__tags">${tags}</div>` : ''}
      <div class="note-card__date">${fmtDate(note.updatedAt)}</div>
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

// ------------------------------------------------------------------- NOTES VIEW
function renderNotesList() {
  const { category, query } = state.notesFilter;
  let notes = Storage.getNotes();
  if (category !== 'all') notes = notes.filter((n) => n.category === category);
  if (query.trim()) {
    const q = query.trim().toLowerCase();
    notes = notes.filter((n) =>
      (n.title + ' ' + n.body + ' ' + (n.tags || []).join(' ')).toLowerCase().includes(q)
    );
  }
  $('#notesList').innerHTML = notes.length
    ? notes.map(renderNoteCardHTML).join('')
    : `<div class="empty-state">Ничего не найдено. Попробуйте другой запрос или категорию.</div>`;
}

function bindNotes() {
  renderNotesFilterChips();

  $('#notesSearch').addEventListener('input', (e) => {
    state.notesFilter.query = e.target.value;
    renderNotesList();
  });

  $('#notesFilterChips').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-catfilter]');
    if (!chip) return;
    state.notesFilter.category = chip.dataset.catfilter;
    renderNotesFilterChips();
    renderNotesList();
    TG.haptic('selection');
  });

  $('#notesList').addEventListener('click', (e) => {
    const card = e.target.closest('.note-card');
    if (!card) return;
    openNoteModal(card.dataset.noteId);
  });
  $('#homeRecent').addEventListener('click', (e) => {
    const card = e.target.closest('.note-card');
    if (!card) return;
    openNoteModal(card.dataset.noteId);
  });

  $('#btnNewNote').addEventListener('click', () => openNoteModal(null));
  $('#btnHomeAll').addEventListener('click', () => switchView('notes'));
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
    $('#btnDeleteNote').hidden = false;
  } else {
    $('#noteModalId').textContent = 'новая';
    $('#noteTitle').value = '';
    $('#noteBody').value = '';
    $('#noteCategory').value = 'idea';
    $('#noteTags').value = '';
    $('#btnDeleteNote').hidden = true;
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

function bindNoteModal() {
  $('#noteModalClose').addEventListener('click', closeNoteModal);
  $('#noteModal').addEventListener('click', (e) => { if (e.target.id === 'noteModal') closeNoteModal(); });

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
      Storage.addNote(payload);
      toast('Заметка добавлена');
    }
    TG.haptic('success');
    closeNoteModal();
    renderHome();
    if (state.view === 'notes') renderNotesList();
  });

  $('#btnDeleteNote').addEventListener('click', async () => {
    if (!state.editingNoteId) return;
    const ok = await TG.showConfirm('Удалить эту заметку без возможности восстановления?');
    if (!ok) return;
    Storage.deleteNote(state.editingNoteId);
    TG.haptic('warning');
    toast('Заметка удалена');
    closeNoteModal();
    renderHome();
    if (state.view === 'notes') renderNotesList();
  });

  $('#btnAutoTag').addEventListener('click', async (e) => {
    if (!currentNoteFieldsValid()) { toast('Сначала напишите текст заметки'); return; }
    await withBusy(e.currentTarget, async () => {
      try {
        const result = await Together.categorizeNote($('#noteBody').value);
        if (!$('#noteTitle').value.trim() && result.title) $('#noteTitle').value = result.title;
        $('#noteCategory').value = result.category;
        $('#noteTags').value = result.tags.join(', ');
        TG.haptic('success');
        toast('Заметка размечена ✨');
      } catch (err) { handleError(err); }
    }, '✨ Думаю…');
  });

  $('#btnExtractTasks').addEventListener('click', async (e) => {
    if (!currentNoteFieldsValid()) { toast('Сначала напишите текст заметки'); return; }
    await withBusy(e.currentTarget, async () => {
      try {
        const tasks = await Together.extractTasksFromText($('#noteBody').value);
        state.extractedTasksBuffer = tasks;
        const out = $('#noteAiOutput');
        if (!tasks.length) {
          out.innerHTML = `<div>Явных задач в тексте не нашлось.</div>`;
        } else {
          out.innerHTML = `
            <div style="margin-bottom:8px;font-weight:700">Найдено задач: ${tasks.length}</div>
            <ul style="margin:0 0 10px;padding-left:18px;display:flex;flex-direction:column;gap:5px">
              ${tasks.map((t, i) => `<li>${escapeHtml(t.text)}</li>`).join('')}
            </ul>
            <button class="btn btn--brass btn--sm" id="btnAddAllTasks" type="button">Добавить все в задачи</button>`;
        }
        out.hidden = false;
        TG.haptic('success');
      } catch (err) { handleError(err); }
    }, '✅ Ищу…');
  });

  $('#noteAiOutput').addEventListener('click', (e) => {
    if (e.target.id === 'btnAddAllTasks') {
      state.extractedTasksBuffer.forEach((t) => {
        Storage.addTask({ text: t.text, priority: t.priority || 'normal', sourceNoteId: state.editingNoteId });
      });
      toast(`Добавлено задач: ${state.extractedTasksBuffer.length}`);
      TG.haptic('success');
      $('#noteAiOutput').hidden = true;
      renderHome();
      if (state.view === 'tasks') renderTasks();
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

  $('#noteAiOutput').addEventListener('click', (e) => {
    if (e.target.id === 'btnUseSummary') {
      $('#noteBody').value = $('#noteAiOutput').dataset.summary || $('#noteBody').value;
      $('#noteAiOutput').hidden = true;
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
    : `<div class="empty-state">Спросите что-нибудь о своих заметках — например «что я думал о смене работы?» или «собери мои идеи для проекта X».</div>`;
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

// ------------------------------------------------------------------- JOURNAL
function renderJournal() {
  const today = Storage.todayKey();
  const entry = Storage.getEntryByDate(today);
  $('#journalDate').textContent = new Date().toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
  $('#journalInput').value = entry ? entry.text : '';
  state.journalMood = entry ? entry.mood : null;
  renderMoodRow();

  const list = Storage.getJournal().filter((e) => e.date !== today);
  $('#journalList').innerHTML = list.length
    ? list.map(renderJournalEntryHTML).join('')
    : `<div class="empty-state">Записей пока нет — начните с сегодняшнего дня выше.</div>`;
}

function renderMoodRow() {
  $('#moodRow').innerHTML = MOODS.map(
    (m) => `<button type="button" class="mood-btn${state.journalMood === m.id ? ' is-active' : ''}" data-mood="${m.id}" title="${m.label}">${m.emoji}</button>`
  ).join('');
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

function bindJournal() {
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
    renderJournal();
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
        renderJournal();
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
        const list = $('#journalList');
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

// ------------------------------------------------------------------- TASKS
function renderTasks() {
  let tasks = Storage.getTasks();
  if (state.tasksFilter === 'open') tasks = tasks.filter((t) => !t.done);
  if (state.tasksFilter === 'done') tasks = tasks.filter((t) => t.done);
  $('#tasksFullList').innerHTML = tasks.length
    ? tasks.map(renderTaskRowHTML).join('')
    : `<div class="empty-state">Здесь пока пусто.</div>`;
}

function bindTasks() {
  $('#taskAddForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#taskAddInput');
    const text = input.value.trim();
    if (!text) return;
    Storage.addTask({ text });
    input.value = '';
    TG.haptic('success');
    renderTasks();
    renderHome();
  });

  $all('[data-taskfilter]').forEach((chip) => {
    chip.addEventListener('click', () => {
      state.tasksFilter = chip.dataset.taskfilter;
      $all('[data-taskfilter]').forEach((c) => c.classList.toggle('is-active', c === chip));
      renderTasks();
    });
  });

  function delegateTaskEvents(container) {
    container.addEventListener('click', (e) => {
      const toggleBtn = e.target.closest('[data-task-toggle]');
      if (toggleBtn) {
        Storage.toggleTask(toggleBtn.dataset.taskToggle);
        TG.haptic('light');
        renderTasks();
        renderHome();
        return;
      }
      const delBtn = e.target.closest('[data-task-del]');
      if (delBtn) {
        Storage.deleteTask(delBtn.dataset.taskDel);
        TG.haptic('warning');
        renderTasks();
        renderHome();
      }
    });
  }
  delegateTaskEvents($('#tasksFullList'));
  delegateTaskEvents($('#homeTasks'));
}

// ------------------------------------------------------------------- SETTINGS MODAL
function openSettingsModal(focusKey = false) {
  const s = Storage.getSettings();
  $('#settingsApiKey').value = s.apiKey || '';
  $('#settingsModel').value = s.model || '';
  $('#settingsUserName').value = s.userName || '';
  $('#apiTestStatus').textContent = '';
  $('#apiTestStatus').className = 'settings-status';
  $('#settingsModal').hidden = false;
  if (focusKey) setTimeout(() => $('#settingsApiKey').focus(), 150);
}
function closeSettingsModal() {
  $('#settingsModal').hidden = true;
  updateApiBanner();
}

function bindSettings() {
  $('#btnSettings').addEventListener('click', () => openSettingsModal(false));
  $('#apiBannerBtn').addEventListener('click', () => openSettingsModal(true));
  $('#settingsModalClose').addEventListener('click', closeSettingsModal);
  $('#settingsModal').addEventListener('click', (e) => { if (e.target.id === 'settingsModal') closeSettingsModal(); });

  $('#btnToggleKey').addEventListener('click', () => {
    const input = $('#settingsApiKey');
    input.type = input.type === 'password' ? 'text' : 'password';
  });

  const saveField = (id, key) => {
    $(id).addEventListener('change', () => {
      Storage.saveSettings({ [key]: $(id).value.trim() });
      updateApiBanner();
    });
  };
  saveField('#settingsApiKey', 'apiKey');
  saveField('#settingsModel', 'model');
  saveField('#settingsUserName', 'userName');

  $('#btnTestApi').addEventListener('click', async (e) => {
    Storage.saveSettings({ apiKey: $('#settingsApiKey').value.trim(), model: $('#settingsModel').value.trim() });
    const status = $('#apiTestStatus');
    await withBusy(e.currentTarget, async () => {
      try {
        await Together.testConnection();
        status.textContent = '✓ Подключение работает';
        status.className = 'settings-status is-ok';
        TG.haptic('success');
        updateApiBanner();
      } catch (err) {
        status.textContent = '✕ ' + (err.message || 'Ошибка подключения');
        status.className = 'settings-status is-err';
        TG.haptic('error');
      }
    }, 'Проверяю…');
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
      renderNotesList();
      renderTasks();
      renderJournal();
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
    : `<div class="empty-state">Сначала добавьте хотя бы одну заметку.</div>`;
  $('#pickerModal').hidden = false;
}

function bindPicker() {
  $('#btnScanNotesForTasks').addEventListener('click', openPickerModal);

  $('#pickerList').addEventListener('click', async (e) => {
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
      renderTasks();
      renderHome();
    } catch (err) {
      handleError(err);
      card.style.opacity = '1';
    }
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
  bindNotes();
  bindNoteModal();
  bindChat();
  bindJournal();
  bindTasks();
  bindSettings();
  bindPicker();
  bindModalBackdrops();
  updateApiBanner();
  switchView('home');

  if (!TG.isTelegram()) {
    console.info('[Второй мозг] Запущено вне Telegram — интеграция WebApp отключена, это нормально для разработки.');
  }
}

document.addEventListener('DOMContentLoaded', init);
