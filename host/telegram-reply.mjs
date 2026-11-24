import { readBoundedTelegramJson } from './telegram-response.mjs';

const MAX_REPLY_CHARS = 3500;
const DEFAULT_REPLY_TIMEOUT_MS = 15_000;

/**
 * Sends a private reply through the Bot API. The token stays in this closure.
 * Failures use a fixed message so a fetch error cannot leak the token URL.
 */
export function createTelegramReplySender({ botToken, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_REPLY_TIMEOUT_MS } = {}) {
  if (typeof botToken !== 'string' || !botToken.trim()) throw new TypeError('Telegram bot token is required.');
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required.');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new RangeError('Telegram reply timeout must be an integer between 1 and 120000 milliseconds.');
  }

  return async function sendReply({ chatId, text, replyToMessageId } = {}) {
    const chat = String(chatId ?? '');
    if (!/^\d{1,16}$/.test(chat) || !Number.isSafeInteger(Number(chat)) || String(Number(chat)) !== chat || Number(chat) <= 0) {
      throw new TypeError('Telegram reply requires a canonical numeric chat ID.');
    }
    if (typeof text !== 'string' || !text.trim() || text.length > MAX_REPLY_CHARS) {
      throw new TypeError('Telegram reply text is missing or too long.');
    }
    const body = {
      chat_id: Number(chat),
      text,
      disable_web_page_preview: true,
    };
    if (Number.isSafeInteger(replyToMessageId) && replyToMessageId >= 0) {
      body.reply_to_message_id = replyToMessageId;
    }

    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error('Telegram reply timed out.'));
    }, timeoutMs);
    try {
      let response;
      try {
        response = await fetchImpl(new URL(`https://api.telegram.org/bot${botToken}/sendMessage`), {
          method: 'POST',
          headers: { 'content-type': 'application/json; charset=utf-8' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch {
        const error = new Error(timedOut ? 'Telegram sendMessage request timed out.' : 'Telegram sendMessage request failed.');
        error.code = timedOut ? 'TELEGRAM_REPLY_TIMEOUT' : 'TELEGRAM_REPLY_FAILED';
        throw error;
      }
      if (!response?.ok) {
        // Best-effort cleanup must not hold the caller open past the request timeout.
        try {
          const cleanup = response?.body?.cancel?.();
          cleanup?.catch?.(() => {});
        } catch {
          // Ignore cleanup failures; the HTTP error is the actionable failure.
        }
        const error = new Error('Telegram sendMessage failed with HTTP ' + (response?.status ?? 'unknown') + '.');
        error.code = 'TELEGRAM_REPLY_FAILED';
        throw error;
      }
      let payload;
      try {
        payload = await readBoundedTelegramJson(response);
      } catch {
        const error = new Error(timedOut ? 'Telegram sendMessage response timed out.' : 'Telegram sendMessage returned an unreadable response.');
        error.code = timedOut ? 'TELEGRAM_REPLY_TIMEOUT' : 'TELEGRAM_REPLY_FAILED';
        throw error;
      }
      if (!payload?.ok || !payload.result || !Number.isSafeInteger(payload.result.message_id)) {
        const error = new Error('Telegram sendMessage returned an invalid response.');
        error.code = 'TELEGRAM_REPLY_FAILED';
        throw error;
      }
    } finally {
      clearTimeout(timeout);
    }
  };
}
