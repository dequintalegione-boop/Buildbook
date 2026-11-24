import { readBoundedTelegramJson } from './telegram-response.mjs';

const MAX_REPLY_CHARS = 3500;

/**
 * Sends a private reply through the Bot API. The token stays in this closure.
 * Failures use a fixed message so a fetch error cannot leak the token URL.
 */
export function createTelegramReplySender({ botToken, fetchImpl = globalThis.fetch } = {}) {
  if (typeof botToken !== 'string' || !botToken.trim()) throw new TypeError('Telegram bot token is required.');
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required.');

  return async function sendReply({ chatId, text, replyToMessageId } = {}) {
    const chat = String(chatId ?? '');
    if (!/^\d{1,16}$/.test(chat) || String(Number(chat)) !== chat || Number(chat) <= 0) {
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

    let response;
    try {
      response = await fetchImpl(new URL(`https://api.telegram.org/bot${botToken}/sendMessage`), {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify(body),
      });
    } catch {
      const error = new Error('Telegram sendMessage request failed.');
      error.code = 'TELEGRAM_REPLY_FAILED';
      throw error;
    }
    if (!response?.ok) {
      await response?.body?.cancel?.().catch(() => {});
      const error = new Error('Telegram sendMessage failed with HTTP ' + (response?.status ?? 'unknown') + '.');
      error.code = 'TELEGRAM_REPLY_FAILED';
      throw error;
    }
    const payload = await readBoundedTelegramJson(response);
    if (!payload?.ok || !payload.result || !Number.isSafeInteger(payload.result.message_id)) {
      const error = new Error('Telegram sendMessage returned an invalid response.');
      error.code = 'TELEGRAM_REPLY_FAILED';
      throw error;
    }
  };
}
