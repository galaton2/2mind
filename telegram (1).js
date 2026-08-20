// =============================================================================
// telegram.js — тонкая обёртка над window.Telegram.WebApp.
// Если аппа открыта не в Telegram (например, в обычном браузере на этапе
// разработки), все функции просто no-op — ничего не сломается.
// =============================================================================

// Интерфейс теперь всегда тёмный/чёрный (см. styles.css), поэтому шапку и
// нижнюю плашку Telegram-клиента жёстко красим в чёрный, а не подстраиваем
// под тему пользователя — иначе на светлой теме Telegram шапка «спорила» бы
// с чёрным интерфейсом приложения.
const HEADER_COLOR = '#000000';
const BG_COLOR = '#0A0A0C';

function tg() {
  return window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
}

function isTelegram() {
  return !!tg();
}

function init() {
  const app = tg();
  if (!app) return;
  app.ready();
  app.expand();
  try { app.enableClosingConfirmation?.(); } catch {}
  applyTheme();
  app.onEvent?.('themeChanged', applyTheme);
}

// Переносим цвета темы Telegram в CSS-переменные там, где это уместно
// (hint/separator), но фон и текст держим фиксированно тёмными — дизайн
// приложения теперь чёрный вне зависимости от системной темы клиента.
function applyTheme() {
  const app = tg();
  const root = document.documentElement.style;
  const p = app?.themeParams || {};
  if (p.hint_color) root.setProperty('--text-dim', p.hint_color);
  if (p.section_separator_color) root.setProperty('--border', p.section_separator_color);

  if (app) {
    try {
      app.setBackgroundColor?.(BG_COLOR);
      app.setHeaderColor?.(HEADER_COLOR);
      app.setBottomBarColor?.(BG_COLOR);
    } catch {}
  }
}

function haptic(type = 'light') {
  const app = tg();
  if (!app?.HapticFeedback) return;
  try {
    if (type === 'success' || type === 'error' || type === 'warning') {
      app.HapticFeedback.notificationOccurred(type);
    } else if (type === 'selection') {
      app.HapticFeedback.selectionChanged();
    } else {
      app.HapticFeedback.impactOccurred(type); // 'light' | 'medium' | 'heavy'
    }
  } catch {}
}

function getUser() {
  const app = tg();
  return app?.initDataUnsafe?.user || null;
}

function showBackButton(onClick) {
  const app = tg();
  if (!app?.BackButton) return;
  app.BackButton.show();
  app.BackButton.onClick(onClick);
}
function hideBackButton() {
  const app = tg();
  app?.BackButton?.hide();
}

function close() {
  tg()?.close();
}

// Промис-обёртка над нативным диалогом подтверждения Telegram.
// Вне Telegram (обычный браузер) откатывается на window.confirm.
function showConfirm(message) {
  return new Promise((resolve) => {
    const app = tg();
    if (app?.showConfirm) {
      app.showConfirm(message, (confirmed) => resolve(!!confirmed));
    } else {
      resolve(window.confirm(message));
    }
  });
}

function showAlert(message) {
  return new Promise((resolve) => {
    const app = tg();
    if (app?.showAlert) {
      app.showAlert(message, () => resolve());
    } else {
      window.alert(message);
      resolve();
    }
  });
}

export const TG = { init, isTelegram, applyTheme, haptic, getUser, showBackButton, hideBackButton, close, showConfirm, showAlert };
