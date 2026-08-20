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
  homeRange: 'year',
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

// ------------------------------------------------------------------- HOME: stats + chart
function renderHome() {
  updateApiBanner();
  const stats = Storage.getStats();
  $('#streakValue').textContent = stats.streak;

  $('#statsGrid').innerHTML = `
    <div class="stat-card"><div class="stat-card__top"><span class="stat-card__label">Заметок</span></div><div class="stat-card__value">${stats.notesCount}</div></div>
    <div class="stat-card stat-card--accent"><div class="stat-card__top"><span class="stat-card__label">Задач выполнено</span></div><div class="stat-card__value">${stats.tasksDone}<span class="stat-card__unit">/${stats.tasksDone + stats.tasksOpen}</span></div></div>
    <div class="stat-card"><div class="stat-card__top"><span class="stat-card__label">Серия дней</span></div><div class="stat-card__value">${stats.streak}<span class="stat-card__unit">🔥</span></div></div>
    <div class="stat-card"><div class="stat-card__top"><span class="stat-card__label">Слов написано</span></div><div class="stat-card__value">${stats.wordsWritten}</div></div>
  `;

  const recent = [...Storage.getNotes()].sort((a, b) => (b.pinned - a.pinned) || (b.updatedAt - a.updatedAt)).slice(0, 4);
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

  renderActivityChart();
}

function updateApiBanner() {
  const hasKey = !!(Storage.getSettings().apiKey || '').trim();
  $('#apiBanner').hidden = hasKey;
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

function buildChartSVG(labels, counts) {
  const W = 320, H = 150, padL = 6, padR = 30, padB = 20, padT = 6;
  const chartW = W - padL - padR;
  const chartH = H - padT - padB;
  const n = counts.length;
  const maxCount = Math.max(1, ...counts);
  const slot = chartW / n;
  const barW = Math.max(4, Math.min(20, slot * 0.5));

  let bars = '';
  let labelsHTML = '';
  const cumulative = [];
  let running = 0;
  counts.forEach((c) => { running += c; cumulative.push(running); });
  const maxCum = Math.max(1, running);
  let linePoints = [];

  counts.forEach((c, i) => {
    const cx = padL + slot * i + slot / 2;
    const barH = c > 0 ? Math.max(3, (c / maxCount) * chartH) : 2;
    const y = padT + (chartH - barH);
    const isRecent = i >= n - 2;
    const color = c > 0 ? (isRecent ? 'var(--brass)' : '#3A3B42') : '#232429';
    bars += `<rect x="${(cx - barW / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" rx="${Math.min(5, barW / 2).toFixed(1)}" fill="${color}"></rect>`;
    if (n <= 12) {
      labelsHTML += `<text x="${cx.toFixed(1)}" y="${H - 4}" font-size="8" fill="var(--tg-hint)" text-anchor="middle" font-family="IBM Plex Mono, monospace">${escapeHtml(String(labels[i]))}</text>`;
    }
    const lx = cx;
    const ly = padT + (chartH - (cumulative[i] / maxCum) * chartH);
    linePoints.push([lx, ly]);
  });

  let linePath = '';
  if (linePoints.length > 1) {
    linePath = 'M ' + linePoints.map((p) => p.map((v) => v.toFixed(1)).join(',')).join(' L ');
  }
  const last = linePoints[linePoints.length - 1];

  return `
    <svg class="chart-svg" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
      <line x1="${padL}" y1="${padT}" x2="${W - padR}" y2="${padT}" stroke="var(--tg-section-separator)" stroke-width="0.5" stroke-dasharray="2 3"/>
      <line x1="${padL}" y1="${padT + chartH / 2}" x2="${W - padR}" y2="${padT + chartH / 2}" stroke="var(--tg-section-separator)" stroke-width="0.5" stroke-dasharray="2 3"/>
      ${bars}
      ${linePoints.length > 1 ? `<path d="${linePath}" fill="none" stroke="var(--brass)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" opacity="0.9"/>` : ''}
      ${last ? `<circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="3" fill="var(--brass)" stroke="#0A0A0C" stroke-width="1.5"/>` : ''}
      ${labelsHTML}
    </svg>`;
}

function renderActivityChart() {
  const { labels, counts, subLabel } = computeBuckets(state.homeRange);
  $('#chartSubLabel').textContent = subLabel;
  $('#chartYearLabel').textContent = state.homeRange === 'all' ? 'Всё время' : String(new Date().getFullYear());
  const total = counts.reduce((a, b) => a + b, 0);
  $('#chartMount').innerHTML = total > 0
    ? buildChartSVG(labels, counts)
    : `<div class="chart-empty">Пока нет данных для графика — добавьте пару заметок 📝</div>`;
}

function bindHomeRange() {
  $('#homeRange').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-range]');
    if (!btn) return;
    state.homeRange = btn.dataset.range;
    $all('#homeRange [data-range]').forEach((b) => b.classList.toggle('is-active', b === btn));
    TG.haptic('selection');
    renderActivityChart();
  });
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

  $('#btnExportShare').addEventListener('click', () => $('#btnExport').click());
  bindHomeRange();
}

// ------------------------------------------------------------------- NOTE CARD (общий рендер)
function renderNoteCardHTML(note) {
  const cat = Storage.categoryById(note.category);
  const title = note.title || (note.body.length > 46 ? note.body.slice(0, 46).trim() + '…' : note.body);
  const bodyPreview = note.title ? note.body : '';
  const tags = (note.tags || []).map((t) => `<span class="tag-pill">#${escapeHtml(t)}</span>`).join('');
  return `
    <article class="note-card${note.pinned ? ' is-pinned' : ''}" style="--cat-color:${cat.color}" data-note-id="${note.id}">
      <button class="note-card__pin${note.pinned ? ' is-active' : ''}" data-pin-toggle="${note.id}" type="button" aria-label="Закрепить" title="Закрепить">📌</button>
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
  notes = [...notes].sort((a, b) => (b.pinned - a.pinned) || (b.updatedAt - a.updatedAt));
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

  function delegateNoteCardEvents(container) {
    container.addEventListener('click', (e) => {
      const pinBtn = e.target.closest('[data-pin-toggle]');
      if (pinBtn) {
        e.stopPropagation();
        Storage.togglePinNote(pinBtn.dataset.pinToggle);
        TG.haptic('selection');
        renderNotesList();
        renderHome();
        return;
      }
      const card = e.target.closest('.note-card');
      if (!card) return;
      openNoteModal(card.dataset.noteId);
    });
  }
  delegateNoteCardEvents($('#notesList'));
  delegateNoteCardEvents($('#homeRecent'));

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
    $('#btnPinNote').classList.toggle('is-active', !!note.pinned);
  } else {
    $('#noteModalId').textContent = 'новая';
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
      renderHome();
      if (state.view === 'notes') renderNotesList();
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
              ${tasks.map((t) => `<li>${escapeHtml(t.text)}</li>`).join('')}
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

  // ИСПРАВЛЕНИЕ БАГА: раньше ключ сохранялся только по событию 'change'
  // (срабатывает лишь при потере фокуса поля), поэтому баннер "нет ключа"
  // мог не исчезать сразу после вставки/ввода ключа. Теперь сохраняем и
  // обновляем баннер на КАЖДОЕ изменение поля — сразу, без ожидания blur.
  $('#settingsApiKey').addEventListener('input', (e) => {
    Storage.saveSettings({ apiKey: e.target.value.trim() });
    updateApiBanner();
  });
  $('#settingsModel').addEventListener('input', (e) => {
    Storage.saveSettings({ model: e.target.value.trim() });
  });
  $('#settingsUserName').addEventListener('input', (e) => {
    Storage.saveSettings({ userName: e.target.value.trim() });
  });

  $('#btnTestApi').addEventListener('click', async (e) => {
    Storage.saveSettings({ apiKey: $('#settingsApiKey').value.trim(), model: $('#settingsModel').value.trim() });
    updateApiBanner();
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
      renderTasks();
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
// Работает целиком на фронтенде, без бэкенда и без эмбеддингов.
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

function openBrainModal() {
  renderBrainMap();
  $('#brainModal').hidden = false;
  TG.haptic('light');
}
function closeBrainModal() {
  $('#brainModal').hidden = true;
}

function bindBrain() {
  $('#btnBrain').addEventListener('click', openBrainModal);
  $('#btnBrainTeaser').addEventListener('click', openBrainModal);
  $('#brainModalClose').addEventListener('click', closeBrainModal);
  $('#brainModal').addEventListener('click', (e) => { if (e.target.id === 'brainModal') closeBrainModal(); });

  $('#brainCanvasWrap').addEventListener('click', (e) => {
    const node = e.target.closest('.brain-node');
    if (!node) return;
    const noteId = node.dataset.noteId;
    closeBrainModal();
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
    text: 'На главном экране есть поле «Запишите мысль…» — вводите идею, задачу или наблюдение в один клик, без лишних полей.',
  },
  {
    icon: '✨',
    title: 'ИИ помогает разложить по полочкам',
    text: 'Откройте заметку и нажмите «Разложить по полочкам» — модель сама подберёт категорию, теги и заголовок. Может также сжать текст или найти в нём задачи.',
  },
  {
    icon: '💬',
    title: 'Чат с собственными заметками',
    text: 'На вкладке «ИИ-чат» можно спрашивать что угодно о своих записях — ИИ найдёт релевантные заметки (RAG) и ответит с указанием источников.',
  },
  {
    icon: '📔',
    title: 'Дневник и инсайты',
    text: 'Ведите ежедневные записи с настроением — ИИ подскажет короткую рефлексию дня и итог недели, отследит вашу серию дней подряд 🔥.',
  },
  {
    icon: '🧠',
    title: 'Карта мыслей',
    text: 'Иконка 🧠 в шапке открывает визуальную карту — заметки показаны как нейроны: расположение по датам, связи по общим тегам.',
  },
  {
    icon: '🔑',
    title: 'Один шаг перед стартом',
    text: 'ИИ-функции работают через Together AI — добавьте свой бесплатный API-ключ в Настройках (⚙), и всё заработает. Без ключа заметки и задачи всё равно можно вести.',
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
  bindNotes();
  bindNoteModal();
  bindChat();
  bindJournal();
  bindTasks();
  bindSettings();
  bindPicker();
  bindBrain();
  bindOnboarding();
  bindModalBackdrops();
  updateApiBanner();
  switchView('home');

  if (!Storage.isOnboarded()) {
    showOnboarding();
  }

  if (!TG.isTelegram()) {
    console.info('[Второй мозг] Запущено вне Telegram — интеграция WebApp отключена, это нормально для разработки.');
  }
}

document.addEventListener('DOMContentLoaded', init);
