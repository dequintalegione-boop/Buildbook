/**
 * Accepts Telegram updates only from explicitly allowed numeric user IDs.
 * Rejected updates are intentionally not persisted, keeping their message data
 * out of the local inbox and financial domain.
 */
const USER_ID = /^\d{1,20}$/;

function senderIdOf(update) {
  const sender = update?.message?.from
    ?? update?.edited_message?.from
    ?? update?.callback_query?.from
    ?? update?.inline_query?.from;
  const id = sender?.id;
  if (typeof id !== 'number' && typeof id !== 'string') return null;
  const normalized = String(id);
  return USER_ID.test(normalized) ? normalized : null;
}

function normalizeAllowlist(allowlist) {
  if (!Array.isArray(allowlist)) throw new TypeError('Telegram allowlist must be an array of numeric user IDs.');
  const result = new Set();
  for (const id of allowlist) {
    const normalized = String(id);
    if (!USER_ID.test(normalized)) throw new TypeError('Telegram allowlist contains an invalid user ID.');
    result.add(normalized);
  }
  return result;
}

/**
 * @param {{ inbox: { enqueue: Function }, botId: string, allowlist: string[] }} options
 * @param {object} update Raw Telegram update received from getUpdates.
 */
export function createTelegramUpdateGate({ inbox, botId, allowlist } = {}) {
  if (!inbox || typeof inbox.enqueue !== 'function') throw new TypeError('A durable inbox is required.');
  if (typeof botId !== 'string' || !botId.trim()) throw new TypeError('A Telegram bot identity is required.');
  const allowed = normalizeAllowlist(allowlist);

  return Object.freeze({
    async accept(update) {
      const userId = senderIdOf(update);
      if (!userId || !allowed.has(userId)) {
        return { accepted: false, reason: 'not_allowed' };
      }
      if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0) {
        throw new TypeError('A valid Telegram update_id is required.');
      }
      const result = await inbox.enqueue({
        botId,
        updateId: update.update_id,
        userId,
        update,
      });
      return { accepted: true, ...result };
    },
  });
}
