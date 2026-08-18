// =============================================================================
// telegram.js — тонкая обёртка над window.Telegram.WebApp.
// Если аппа открыта не в Telegram (например, в обычном браузере на этапе
// разработки), все функции просто no-op — ничего не сломается.
// =============================================================================

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

// Переносим цвета темы Telegram в CSS-переменные, чтобы интерфейс совпадал
// с системной темой пользователя (светлая/тёмная/кастомная в клиенте Telegram).
function applyTheme() {
  const app = tg();
  const root = document.documentElement.style;
  const p = app?.themeParams || {};
  if (p.bg_color) root.setProperty('--tg-bg', p.bg_color);
  if (p.secondary_bg_color) root.setProperty('--tg-secondary-bg', p.secondary_bg_color);
  if (p.text_color) root.setProperty('--tg-text', p.text_color);
  if (p.hint_color) root.setProperty('--tg-hint', p.hint_color);
  if (p.section_separator_color) root.setProperty('--tg-section-separator', p.section_separator_color);

  if (app) {
    try {
      app.setBackgroundColor?.(p.bg_color || '#FAF8F4');
      app.setHeaderColor?.(p.bg_color || '#FAF8F4');
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
