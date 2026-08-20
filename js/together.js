// =============================================================================
// together.js — обёртка над Together AI (OpenAI-совместимый /chat/completions)
// и «мозговые» функции второго мозга: RAG-чат по заметкам, автотегирование,
// извлечение задач, саммаризация, дневные/недельные инсайты.
//
// ВАЖНО: ключ уходит из браузера напрямую в api.together.xyz. Это нормально
// для локального теста, но перед публикацией бота вынесите эти вызовы на свой
// сервер (см. README), иначе ключ сможет прочитать любой пользователь мини-аппа.
// =============================================================================

import { Storage } from './storage.js';

const API_URL = 'https://api.together.xyz/v1/chat/completions';

class TogetherError extends Error {}

async function rawChat(messages, { temperature = 0.6, maxTokens = 900, model } = {}) {
  const settings = Storage.getSettings();
  const apiKey = settings.apiKey;
  if (!apiKey) throw new TogetherError('Не задан API-ключ Together. Откройте настройки (⚙) и вставьте ключ.');

  let response;
  try {
    response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model || settings.model || 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
        messages,
        temperature,
        max_tokens: maxTokens,
      }),
    });
  } catch (networkErr) {
    throw new TogetherError('Сеть недоступна или запрос заблокирован (CORS). Подробности — в README.');
  }

  if (!response.ok) {
    let detail = '';
    try {
      const errJson = await response.json();
      detail = errJson?.error?.message || JSON.stringify(errJson);
    } catch {
      detail = await response.text();
    }
    if (response.status === 401) throw new TogetherError('Неверный API-ключ (401). Проверьте ключ в настройках.');
    if (response.status === 429) throw new TogetherError('Превышен лимит запросов (429). Подождите и попробуйте снова.');
    throw new TogetherError(`Together API вернул ошибку ${response.status}: ${detail}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new TogetherError('Пустой ответ модели.');
  return content;
}

// Пытается вытащить JSON из ответа модели, даже если она обрамила его текстом
// или обратными кавычками — большинство open-source моделей иногда так делают.
function extractJSON(text) {
  const cleaned = text.replace(/```json|```/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        /* falls through */
      }
    }
    throw new TogetherError('Не удалось разобрать JSON-ответ модели.');
  }
}

// -----------------------------------------------------------------------
// Простой поиск релевантных заметок по пересечению слов — работает без
// эмбеддингов и лишних запросов к API. Достаточно для локальной базы
// в сотни-тысячи заметок и держит RAG-контекст компактным и дешёвым.
// -----------------------------------------------------------------------
const STOPWORDS = new Set([
  'и','в','во','не','что','он','на','я','с','со','как','а','то','все','она','так','его','но','да','ты',
  'к','у','же','вы','за','бы','по','только','ее','мне','было','вот','от','меня','еще','нет','о','из',
  'ему','теперь','когда','даже','ну','вдруг','ли','если','уже','или','ни','быть','был','него','до',
  'вас','нибудь','опять','уж','вам','сказал','ведь','там','потом','себя','ничего','ей','может','они',
  'тут','где','есть','надо','ней','для','мы','тебя','их','чем','была','сам','чтоб','без','будто','человек',
  'этот','эта','это','эти','про','это','the','and','for','with','that','this','are','was','you','your',
]);

function tokenize(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

function scoreNote(queryTokens, note) {
  const noteTokens = tokenize(`${note.title} ${note.body} ${(note.tags || []).join(' ')}`);
  if (!noteTokens.length) return 0;
  const freq = {};
  noteTokens.forEach((t) => (freq[t] = (freq[t] || 0) + 1));
  let score = 0;
  queryTokens.forEach((q) => {
    if (freq[q]) score += freq[q];
  });
  return score;
}

function findRelevantNotes(query, notes, limit = 6) {
  const qTokens = tokenize(query);
  if (!qTokens.length) {
    // без чёткого запроса — возьмём последние заметки, чтобы был хоть какой-то контекст
    return notes.slice(0, Math.min(limit, notes.length));
  }
  const scored = notes
    .map((n) => ({ note: n, score: scoreNote(qTokens, n) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.note);
  return scored;
}

function noteToContextBlock(note) {
  const cat = Storage.categoryById(note.category);
  const date = new Date(note.createdAt).toLocaleDateString('ru-RU');
  return `[#${String(note.number).padStart(4, '0')} · ${cat.label} · ${date}] ${note.title ? note.title + ' — ' : ''}${note.body}`;
}

// -----------------------------------------------------------------------
// Публичные функции
// -----------------------------------------------------------------------

async function testConnection() {
  await rawChat(
    [{ role: 'user', content: 'Ответь одним словом: привет' }],
    { maxTokens: 10, temperature: 0 }
  );
  return true;
}

// RAG-чат: подбираем релевантные заметки, кладём их в system-промпт, отвечаем.
async function ragChat(userMessage, history = []) {
  const notes = Storage.getNotes();
  const relevant = findRelevantNotes(userMessage, notes, 6);

  const contextBlock = relevant.length
    ? relevant.map(noteToContextBlock).join('\n---\n')
    : '(в базе пока нет заметок, отвечай на основе общих знаний и предложи начать с добавления заметок)';

  const systemPrompt =
    'Ты — личный ассистент «Второй мозг» пользователя. У тебя есть доступ к выдержкам из его заметок ' +
    '(см. ниже). Отвечай по-русски, кратко и по делу, опираясь в первую очередь на заметки пользователя. ' +
    'Если в заметках нет ответа — честно скажи об этом и ответь исходя из общих знаний. ' +
    'Не выдумывай факты о жизни пользователя, которых нет в заметках.\n\n' +
    `КОНТЕКСТ ИЗ ЗАМЕТОК:\n${contextBlock}`;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.slice(-10).map((m) => ({ role: m.role === 'ai' ? 'assistant' : 'user', content: m.content })),
    { role: 'user', content: userMessage },
  ];

  const reply = await rawChat(messages, { temperature: 0.6, maxTokens: 700 });
  return { reply, sources: relevant.map((n) => ({ id: n.id, number: n.number, title: n.title || n.body.slice(0, 30) })) };
}

// Автотегирование: категория + теги + короткий заголовок
async function categorizeNote(text) {
  const categories = Storage.getCategories();
  const catList = categories.map((c) => `${c.id} (${c.label})`).join(', ');
  const messages = [
    {
      role: 'system',
      content:
        'Ты помогаешь разложить заметку по полочкам. Верни СТРОГО JSON без пояснений и без markdown-обрамления ' +
        `в формате {"title": "...", "category": "один из: ${catList}", "tags": ["...", "..."]}. ` +
        'title — короткий заголовок (до 6 слов) на русском. tags — 2-5 тегов в нижнем регистре без #.',
    },
    { role: 'user', content: text },
  ];
  const raw = await rawChat(messages, { temperature: 0.3, maxTokens: 300 });
  const parsed = extractJSON(raw);
  const validCategory = categories.some((c) => c.id === parsed.category) ? parsed.category : 'other';
  return {
    title: typeof parsed.title === 'string' ? parsed.title.slice(0, 80) : '',
    category: validCategory,
    tags: Array.isArray(parsed.tags) ? parsed.tags.slice(0, 6).map(String) : [],
  };
}

// Извлечение задач из текста заметки
async function extractTasksFromText(text) {
  const messages = [
    {
      role: 'system',
      content:
        'Найди в тексте конкретные действия/задачи, которые нужно сделать. Верни СТРОГО JSON-массив без пояснений: ' +
        '[{"text": "...", "priority": "low|normal|high"}]. Если задач нет — верни []. Текст задач — на русском, кратко, в повелительном наклонении.',
    },
    { role: 'user', content: text },
  ];
  const raw = await rawChat(messages, { temperature: 0.3, maxTokens: 400 });
  const parsed = extractJSON(raw);
  return Array.isArray(parsed) ? parsed.filter((t) => t && t.text) : [];
}

// Сжатие заметки до короткого резюме
async function summarizeText(text) {
  const messages = [
    { role: 'system', content: 'Сожми текст до 2-3 предложений на русском, сохранив ключевую мысль. Без вводных фраз.' },
    { role: 'user', content: text },
  ];
  return rawChat(messages, { temperature: 0.4, maxTokens: 250 });
}

// Резюме дня по дневниковой записи
async function summarizeDay(entryText, mood) {
  const messages = [
    {
      role: 'system',
      content:
        'Ты — тёплый, наблюдательный дневниковый ассистент. По записи пользователя за день дай короткую (2-3 предложения) ' +
        'рефлексию на русском: подметь настроение и предложи мягкий вывод или вопрос для размышления. Без клише и без нравоучений.',
    },
    { role: 'user', content: `Настроение: ${mood || 'не указано'}\nЗапись: ${entryText}` },
  ];
  return rawChat(messages, { temperature: 0.7, maxTokens: 250 });
}

// Итог недели по нескольким записям дневника
async function weeklyInsight(entries) {
  const block = entries
    .map((e) => `${e.date} (настроение: ${e.mood || '—'}): ${e.text}`)
    .join('\n');
  const messages = [
    {
      role: 'system',
      content:
        'На основе дневниковых записей за последние дни найди повторяющиеся темы, эмоциональную динамику и одно ' +
        'конструктивное наблюдение. Ответ на русском, 3-4 предложения, без воды.',
    },
    { role: 'user', content: block },
  ];
  return rawChat(messages, { temperature: 0.6, maxTokens: 350 });
}

export const Together = {
  TogetherError,
  testConnection,
  ragChat,
  categorizeNote,
  extractTasksFromText,
  summarizeText,
  summarizeDay,
  weeklyInsight,
  findRelevantNotes,
};
