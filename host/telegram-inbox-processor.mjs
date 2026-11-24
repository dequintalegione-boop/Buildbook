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
  const botId = String(item?.botId ?? '');
  const key = String(item?.key ?? '');
  if (!/^\d{1,16}$/.test(userId)
    || !Number.isSafeInteger(Number(userId)) || Number(userId) <= 0
    || String(Number(userId)) !== userId
    || !/^\d{1,16}$/.test(botId)
    || Number(botId) <= 0 || !Number.isSafeInteger(Number(botId))
    || String(Number(botId)) !== botId
    || !/^\d{1,16}:\d+$/.test(key)
    || key !== botId + ':' + String(item?.updateId)
    || !Number.isSafeInteger(item?.updateId) || item.updateId < 0 || item.updateId >= Number.MAX_SAFE_INTEGER
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

  // Treat the durable file as untrusted too. Rebuild the narrow envelope
  // instead of forwarding arbitrary extra fields from a tampered record.
  return {
    update_id: item.updateId,
    message: {
      message_id: message.message_id,
      from: { id: Number(userId) },
      chat: { id: Number(userId), type: 'private' },
      text: message.text,
    },
  };
}

export function createTelegramInboxProcessor({ inbox, applyUpdate, deliverReply } = {}) {
  if (!inbox || typeof inbox.nextPending !== 'function'
    || typeof inbox.markProcessing !== 'function'
    || typeof inbox.markPending !== 'function'
    || typeof inbox.markCompleted !== 'function'
    || typeof inbox.markRejected !== 'function') {
    throw new TypeError('A compatible durable Telegram inbox is required.');
  }
  if (typeof applyUpdate !== 'function') throw new TypeError('A canonical domain update adapter is required.');
  if (deliverReply !== undefined && typeof deliverReply !== 'function') {
    throw new TypeError('deliverReply must be a function when supplied.');
  }

  let active = false;

  function requireTransition(result, transition) {
    if (result === false) {
      const error = new Error(`Telegram inbox item could not be moved to ${transition}.`);
      error.code = 'TELEGRAM_INBOX_TRANSITION_FAILED';
      throw error;
    }
  }

  async function sendReply(item, text) {
    if (!text || typeof deliverReply !== 'function') return;
    if (typeof text !== 'string' || !text.trim() || text.length > 3500) {
      const error = new Error('Telegram reply was rejected before sending.');
      error.code = 'INVALID_TELEGRAM_REPLY';
      throw error;
    }
    await deliverReply({
      chatId: item.userId,
      text,
      replyToMessageId: item.validatedUpdate?.message?.message_id,
    });
  }

  async function processOne() {
    if (active) throw new Error('Telegram inbox processing is already in progress.');
    active = true;
    try {
      const item = await inbox.nextPending();
      if (!item) return { processed: false, reason: 'empty' };
      if (!await inbox.markProcessing(item.id)) return { processed: false, reason: 'claimed_elsewhere' };

      let permanentFailureHandled = false;
      try {
        try {
          item.validatedUpdate = validateInboxCommand(item);
        } catch (error) {
          requireTransition(await inbox.markRejected(item.id, error?.message || 'Invalid inbox item'), 'rejected');
          throw error;
        }
        const result = await applyUpdate({
          update: structuredClone(item.validatedUpdate),
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
        // Reply before completion. A crash after a successful reply retries the
        // same idempotent command and may send the reply once more; a failed
        // reply must not acknowledge the inbox item.
        await sendReply(item, typeof result?.reply === 'string' ? result.reply : '');
        const completed = await inbox.markCompleted(item.id, normalizedOperationId);
        if (completed === false) {
          throw new Error('Telegram inbox item could not be marked completed; retry requires an idempotent domain adapter.');
        }
        return { processed: true, itemId: item.id, operationId: normalizedOperationId };
      } catch (error) {
        if (!permanentFailureHandled && error?.code !== 'INVALID_TELEGRAM_INBOX_ITEM') {
          if (error?.permanent === true) {
            if (typeof error.reply === 'string' && error.reply.trim()) {
              try {
                await sendReply(item, error.reply);
              } catch (replyError) {
                permanentFailureHandled = true;
                requireTransition(await inbox.markPending(item.id, 'Canonical adapter failed; retry scheduled.'), 'pending');
                throw replyError;
              }
            }
            // Unsupported or malformed user commands are terminal; retrying them
            // forever would block every later item in the ordered inbox.
            requireTransition(await inbox.markRejected(item.id, 'Telegram command is unsupported or invalid.'), 'rejected');
            permanentFailureHandled = true;
            // A user-level terminal rejection is not a service failure. Report
            // it as consumed work so the runtime can continue draining the inbox.
            return { processed: true, rejected: true, itemId: item.id };
          } else {
            const safeMessage = 'Canonical adapter failed; retry scheduled.';
            // Do not persist arbitrary exception text: adapters may include user data,
            // request bodies, filesystem paths, or credentials in error messages.
            requireTransition(await inbox.markPending(item.id, safeMessage), 'pending');
          }
        }
        throw error;
      }
    } finally {
      active = false;
    }
  }

  return Object.freeze({ processOne });
}
