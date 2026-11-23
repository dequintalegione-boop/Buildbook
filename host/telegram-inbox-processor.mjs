/**
 * Processes durable Telegram inbox entries through the canonical domain adapter.
 * The adapter MUST use idempotencyKey as a unique key in the same transaction
 * that commits its domain effect. The inbox alone cannot make external writes
 * exactly-once.
 */
function validateInboxCommand(item) {
  const update = item?.update;
  const message = update?.message;
  const userId = String(item?.userId ?? '');
  if (!/^\d{1,16}$/.test(userId)
    || !/^\d{1,16}$/.test(String(item?.botId ?? ''))
    || Number(item.botId) <= 0 || !Number.isSafeInteger(Number(item.botId))
    || !/^\d{1,16}:\d+$/.test(String(item?.key ?? ''))
    || String(item.key).split(':')[0] !== String(item?.botId ?? '')
    || Number(String(item.key).split(':')[1]) !== item?.updateId
    || !Number.isSafeInteger(item?.updateId) || item.updateId < 0
    || update?.update_id !== item.updateId
    || !message
    || !Number.isSafeInteger(message.message_id)
    || message.message_id < 0
    || String(message.from?.id ?? '') !== userId
    || String(message.chat?.id ?? '') !== userId
    || message.chat?.type !== 'private'
    || typeof message.text !== 'string'
    || message.text.length === 0
    || message.text.length > 4096) {
    const error = new TypeError('Telegram inbox item failed the private-text command validation.');
    error.code = 'INVALID_TELEGRAM_INBOX_ITEM';
    throw error;
  }
}

export function createTelegramInboxProcessor({ inbox, applyUpdate } = {}) {
  if (!inbox || typeof inbox.nextPending !== 'function'
    || typeof inbox.markProcessing !== 'function'
    || typeof inbox.markPending !== 'function'
    || typeof inbox.markCompleted !== 'function'
    || typeof inbox.markRejected !== 'function') {
    throw new TypeError('A compatible durable Telegram inbox is required.');
  }
  if (typeof applyUpdate !== 'function') throw new TypeError('A canonical domain update adapter is required.');

  let active = false;

  async function processOne() {
    if (active) throw new Error('Telegram inbox processing is already in progress.');
    active = true;
    try {
      const item = await inbox.nextPending();
      if (!item) return { processed: false, reason: 'empty' };
      if (!await inbox.markProcessing(item.id)) return { processed: false, reason: 'claimed_elsewhere' };

      try {
        try {
          validateInboxCommand(item);
        } catch (error) {
          await inbox.markRejected(item.id, error?.message || 'Invalid inbox item');
          throw error;
        }
        const result = await applyUpdate({
          update: structuredClone(item.update),
          userId: item.userId,
          idempotencyKey: item.key,
          inboxItemId: item.id,
        });
        const operationId = result?.operationId ?? result?.id;
        const normalizedOperationId = typeof operationId === 'string'
          ? operationId.trim()
          : Number.isSafeInteger(operationId) && operationId >= 0
            ? String(operationId)
            : '';
        if (!normalizedOperationId || normalizedOperationId.length > 256) {
          const error = new Error('Canonical adapter did not return a valid committed Buildbook operation ID.');
          error.code = 'MISSING_CANONICAL_OPERATION_ID';
          throw error;
        }
        const completed = await inbox.markCompleted(item.id, normalizedOperationId);
        if (completed === false) {
          throw new Error('Telegram inbox item could not be marked completed; retry requires an idempotent domain adapter.');
        }
        return { processed: true, itemId: item.id, operationId };
      } catch (error) {
        if (error?.code !== 'INVALID_TELEGRAM_INBOX_ITEM') {
          const safeMessage = 'Canonical adapter failed; retry scheduled.';
          // Do not persist arbitrary exception text: adapters may include user data,
          // request bodies, filesystem paths, or credentials in error messages.
          await inbox.markPending(item.id, safeMessage);
        }
        throw error;
      }
    } finally {
      active = false;
    }
  }

  return Object.freeze({ processOne });
}
