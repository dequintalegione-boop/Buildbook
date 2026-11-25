function safeError(error) {
  // Exception messages can contain raw Telegram text, local paths, request
  // URLs, or credentials. Keep only a constrained code and a fixed message.
  return {
    code: 'TELEGRAM_SERVICE_ERROR',
    message: 'Ошибка сервиса Telegram; подробности исключения не сохраняются.',
  };
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
