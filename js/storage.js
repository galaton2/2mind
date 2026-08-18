// =============================================================================
// storage.js — слой данных. Всё завязано на localStorage, но API асинхронный
// (возвращает Promise) специально: когда перенесёте логику на бэкенд, вызовы
// в остальном коде менять не придётся — просто подмените реализацию функций.
// =============================================================================

const KEYS = {
  notes: 'sb_notes',
  tasks: 'sb_tasks',
  journal: 'sb_journal',
  chat: 'sb_chat',
  settings: 'sb_settings',
  meta: 'sb_meta', // счётчики id, серия дней и т.п.
};

const DEFAULT_CATEGORIES = [
  { id: 'idea', label: 'Идея', color: '#A9782E' },
  { id: 'task', label: 'Задача', color: '#35695A' },
  { id: 'learning', label: 'Обучение', color: '#35597A' },
  { id: 'journal', label: 'Дневник', color: '#A8442C' },
  { id: 'work', label: 'Работа', color: '#6B5B95' },
  { id: 'other', label: 'Другое', color: '#8A8478' },
];

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    console.error('storage read error', key, e);
    return fallback;
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    console.error('storage write error', key, e);
    return false;
  }
}

// -------------------------------------------------------------- meta / id
function getMeta() {
  return readJSON(KEYS.meta, { noteCounter: 0, streak: 0, lastActiveDate: null });
}
function saveMeta(meta) {
  return writeJSON(KEYS.meta, meta);
}
function nextNoteNumber() {
  const meta = getMeta();
  meta.noteCounter = (meta.noteCounter || 0) + 1;
  saveMeta(meta);
  return meta.noteCounter;
}

// touches "last active date" and recomputes a simple daily streak
function touchActivity() {
  const meta = getMeta();
  const today = new Date().toISOString().slice(0, 10);
  if (meta.lastActiveDate === today) return meta.streak || 0;
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  if (meta.lastActiveDate === yesterday) {
    meta.streak = (meta.streak || 0) + 1;
  } else {
    meta.streak = 1;
  }
  meta.lastActiveDate = today;
  saveMeta(meta);
  return meta.streak;
}
function getStreak() {
  return getMeta().streak || 0;
}

// -------------------------------------------------------------- settings
function getSettings() {
  return readJSON(KEYS.settings, {
    apiKey: '',
    model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    userName: '',
  });
}
function saveSettings(patch) {
  const current = getSettings();
  const updated = { ...current, ...patch };
  writeJSON(KEYS.settings, updated);
  return updated;
}

// -------------------------------------------------------------- categories
function getCategories() {
  return readJSON('sb_categories', DEFAULT_CATEGORIES);
}
function categoryById(id) {
  return getCategories().find((c) => c.id === id) || getCategories()[getCategories().length - 1];
}

// -------------------------------------------------------------- notes
function getNotes() {
  return readJSON(KEYS.notes, []);
}
function saveNotes(list) {
  writeJSON(KEYS.notes, list);
}
function addNote({ title = '', body, category = 'idea', tags = [] }) {
  const notes = getNotes();
  const note = {
    id: uid(),
    number: nextNoteNumber(),
    title: title.trim(),
    body: body.trim(),
    category,
    tags,
    pinned: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  notes.unshift(note);
  saveNotes(notes);
  touchActivity();
  return note;
}
function updateNote(id, patch) {
  const notes = getNotes();
  const idx = notes.findIndex((n) => n.id === id);
  if (idx === -1) return null;
  notes[idx] = { ...notes[idx], ...patch, updatedAt: Date.now() };
  saveNotes(notes);
  return notes[idx];
}
function deleteNote(id) {
  const notes = getNotes().filter((n) => n.id !== id);
  saveNotes(notes);
}
function getNote(id) {
  return getNotes().find((n) => n.id === id) || null;
}

// -------------------------------------------------------------- tasks
function getTasks() {
  return readJSON(KEYS.tasks, []);
}
function saveTasks(list) {
  writeJSON(KEYS.tasks, list);
}
function addTask({ text, sourceNoteId = null, priority = 'normal', dueDate = null }) {
  const tasks = getTasks();
  const task = {
    id: uid(),
    text: text.trim(),
    done: false,
    priority,
    dueDate,
    sourceNoteId,
    createdAt: Date.now(),
  };
  tasks.unshift(task);
  saveTasks(tasks);
  touchActivity();
  return task;
}
function toggleTask(id) {
  const tasks = getTasks();
  const idx = tasks.findIndex((t) => t.id === id);
  if (idx === -1) return;
  tasks[idx].done = !tasks[idx].done;
  tasks[idx].doneAt = tasks[idx].done ? Date.now() : null;
  saveTasks(tasks);
}
function deleteTask(id) {
  saveTasks(getTasks().filter((t) => t.id !== id));
}

// -------------------------------------------------------------- journal
function getJournal() {
  return readJSON(KEYS.journal, []);
}
function saveJournal(list) {
  writeJSON(KEYS.journal, list);
}
function todayKey() {
  return new Date().toISOString().slice(0, 10);
}
function getEntryByDate(dateKey) {
  return getJournal().find((e) => e.date === dateKey) || null;
}
function upsertJournalEntry({ date = todayKey(), text, mood = null }) {
  const list = getJournal();
  const idx = list.findIndex((e) => e.date === date);
  if (idx === -1) {
    const entry = { id: uid(), date, text, mood, aiSummary: null, createdAt: Date.now(), updatedAt: Date.now() };
    list.unshift(entry);
    saveJournal(list);
    touchActivity();
    return entry;
  }
  list[idx] = { ...list[idx], text, mood: mood ?? list[idx].mood, updatedAt: Date.now() };
  saveJournal(list);
  touchActivity();
  return list[idx];
}
function setJournalAISummary(date, summary) {
  const list = getJournal();
  const idx = list.findIndex((e) => e.date === date);
  if (idx === -1) return;
  list[idx].aiSummary = summary;
  saveJournal(list);
}

// -------------------------------------------------------------- chat
function getChat() {
  return readJSON(KEYS.chat, []);
}
function saveChat(list) {
  writeJSON(KEYS.chat, list);
}
function addChatMessage({ role, content, sources = [] }) {
  const list = getChat();
  const msg = { id: uid(), role, content, sources, ts: Date.now() };
  list.push(msg);
  saveChat(list);
  return msg;
}
function clearChat() {
  saveChat([]);
}

// -------------------------------------------------------------- stats
function getStats() {
  const notes = getNotes();
  const tasks = getTasks();
  const journal = getJournal();
  return {
    notesCount: notes.length,
    tasksOpen: tasks.filter((t) => !t.done).length,
    tasksDone: tasks.filter((t) => t.done).length,
    journalDays: journal.length,
    streak: getStreak(),
  };
}

// -------------------------------------------------------------- export/import
function exportAll() {
  return {
    exportedAt: new Date().toISOString(),
    notes: getNotes(),
    tasks: getTasks(),
    journal: getJournal(),
    chat: getChat(),
    settings: { ...getSettings(), apiKey: '' }, // ключ в экспорт не кладём
    meta: getMeta(),
  };
}
function importAll(data) {
  if (!data || typeof data !== 'object') throw new Error('Некорректный файл');
  if (Array.isArray(data.notes)) saveNotes(data.notes);
  if (Array.isArray(data.tasks)) saveTasks(data.tasks);
  if (Array.isArray(data.journal)) saveJournal(data.journal);
  if (Array.isArray(data.chat)) saveChat(data.chat);
  if (data.meta) saveMeta(data.meta);
  return true;
}
function clearAllData() {
  Object.values(KEYS).forEach((k) => localStorage.removeItem(k));
  localStorage.removeItem('sb_categories');
}

export const Storage = {
  uid,
  getSettings, saveSettings,
  getCategories, categoryById,
  getNotes, addNote, updateNote, deleteNote, getNote,
  getTasks, addTask, toggleTask, deleteTask,
  getJournal, getEntryByDate, upsertJournalEntry, setJournalAISummary, todayKey,
  getChat, addChatMessage, clearChat,
  getStats, getStreak, touchActivity,
  exportAll, importAll, clearAllData,
};
