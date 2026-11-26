/* Buildbook Telegram allowlist UI bridge.
 * Full editor lives in index.html as telegramAllowlistEditor().
 * This file remains for older caches and as a capture-phase safety net.
 */
document.addEventListener('click', function (e) {
  const btn = e.target && e.target.closest && e.target.closest('[data-a="tgallowlist"]');
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  if (typeof telegramAllowlistEditor === 'function') {
    telegramAllowlistEditor();
  } else if (typeof toast === 'function') {
    toast('Редактор белого списка недоступен. Обновите страницу.');
  }
}, true);
