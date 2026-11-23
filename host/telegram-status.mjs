const TOKEN_PATTERN = /bot\d+:[A-Za-z0-9_-]+/gi;

function safeError(error) {
  const message = String(error?.message || 'Telegram service error.')
    .replace(TOKEN_PATTERN, '[redacted Telegram token]')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 500);
  const code = typeof error?.code === 'string' && /^[A-Z0-9_:-]{1,80}$/.test(error.code)
    ? error.code
    : 'TELEGRAM_SERVICE_ERROR';
  return { code, message };
}

/** In-memory operational snapshot. Never stores the bot token or raw updates. */
export function createTelegramStatus({ now = () => new Date().toISOString() } = {}) {
  if (typeof now !== 'function') throw new TypeError('A status clock function is required.');
  let state = {
    startedAt: null,
    lastCycleAt: null,
    lastError: null,
    lastQueue: null,
    lastProcessed: 0,
    consecutiveFailures: 0,
  };

  return Object.freeze({
    started() {
      state = { ...state, startedAt: now(), lastError: null, consecutiveFailures: 0 };
    },
    cycle(result) {
      state = {
        ...state,
        lastCycleAt: now(),
        lastError: null,
        lastQueue: result?.inbox && typeof result.inbox === 'object' ? { ...result.inbox } : state.lastQueue,
        lastProcessed: Number.isSafeInteger(result?.processed) && result.processed >= 0 ? result.processed : 0,
        consecutiveFailures: 0,
      };
    },
    error(error) {
      state = {
        ...state,
        lastError: { ...safeError(error), at: now() },
        consecutiveFailures: state.consecutiveFailures + 1,
      };
    },
    snapshot({ running = false } = {}) {
      return Object.freeze({
        running: Boolean(running),
        startedAt: state.startedAt,
        lastCycleAt: state.lastCycleAt,
        lastError: state.lastError ? { ...state.lastError } : null,
        queue: state.lastQueue ? { ...state.lastQueue } : null,
        lastProcessed: state.lastProcessed,
        consecutiveFailures: state.consecutiveFailures,
      });
    },
  });
}
