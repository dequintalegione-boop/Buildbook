/**
 * Accepts only private-chat text messages from explicitly allowed Telegram users.
 * Raw Telegram objects are untrusted input: persist a minimal, validated envelope
 * rather than forwarding arbitrary fields (attachments, entities, chat metadata).
 */
const MAX_TEXT_LENGTH = 4096;
const MAX_SAFE_TELEGRAM_ID = BigInt(Number.MAX_SAFE_INTEGER);

function numericId(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0)) return null;
  const raw = String(value);
  if (!/^\d{1,16}$/.test(raw)) return null;
  const parsed = BigInt(raw);
  if (parsed <= 0n || parsed > MAX_SAFE_TELEGRAM_ID) return null;
  return parsed.toString();
}

function normalizeAllowlist(allowlist) {
  if (!Array.isArray(allowlist)) throw new TypeError('Telegram allowlist must be an array of numeric user IDs.');
  if (allowlist.length > 100) throw new TypeError('Telegram allowlist cannot exceed 100 user IDs.');
  const result = new Set();
  for (const id of allowlist) {
    const normalized = numericId(id);
    if (!normalized) throw new TypeError('Telegram allowlist contains an invalid user ID.');
    result.add(normalized);
  }
  return result;
}

function privateTextEnvelope(update, userId) {
  const message = update?.message;
  if (!message || message.chat?.type !== 'private') return null;

  const chatId = numericId(message.chat?.id);
  if (!chatId || chatId !== userId) return null;
  if (typeof message.text !== 'string' || message.text.length === 0
    || message.text.length > MAX_TEXT_LENGTH) return null;
  if (!Number.isSafeInteger(message.message_id) || message.message_id < 0) return null;

  // Do not persist the full Telegram object. The domain layer receives only
  // the fields needed to interpret a private text command.
  return {
    update_id: update.update_id,
    message: {
      message_id: message.message_id,
      from: { id: Number(userId) },
      chat: { id: Number(chatId), type: 'private' },
      text: message.text,
    },
  };
}

/**
 * @param {{ inbox: { enqueue: Function }, botId: string, allowlist: string[] }} options
 * @param {object} update Raw Telegram update received from getUpdates.
 */
export function createTelegramUpdateGate({ inbox, botId, allowlist } = {}) {
  if (!inbox || typeof inbox.enqueue !== 'function') throw new TypeError('A durable inbox is required.');
  if (typeof botId !== 'string' || !/^\d{1,16}$/.test(botId)
    || !Number.isSafeInteger(Number(botId)) || Number(botId) <= 0) {
    throw new TypeError('A valid numeric Telegram bot identity is required.');
  }
  botId = String(Number(botId));
  let allowed = normalizeAllowlist(allowlist);

  return Object.freeze({
    getAllowlist() {
      return [...allowed];
    },
    setAllowlist(next) {
      allowed = normalizeAllowlist(next);
      return this.getAllowlist();
    },
    async accept(update) {
      const userId = numericId(update?.message?.from?.id);
      if (!userId || !allowed.has(userId)) {
        return { accepted: false, reason: 'not_allowed' };
      }

      const sanitizedUpdate = privateTextEnvelope(update, userId);
      if (!sanitizedUpdate) {
        return { accepted: false, reason: 'unsupported_update' };
      }
      if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0
        || update.update_id >= Number.MAX_SAFE_INTEGER) {
        throw new TypeError('A valid Telegram update_id is required.');
      }

      const result = await inbox.enqueue({
        botId,
        updateId: update.update_id,
        userId,
        update: sanitizedUpdate,
      });
      return { accepted: true, ...result };
    },
  });
}
