/**
 * Processes durable Telegram inbox entries through the canonical domain adapter.
 * The adapter MUST use idempotencyKey as a unique key in the same transaction
 * that commits its domain effect. The inbox alone cannot make external writes
 * exactly-once.
 */
export function createTelegramInboxProcessor({ inbox, applyUpdate } = {}) {
  if (!inbox || typeof inbox.nextPending !== 'function'
    || typeof inbox.markProcessing !== 'function'
    || typeof inbox.markPending !== 'function'
    || typeof inbox.markCompleted !== 'function') {
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
        const result = await applyUpdate({
          update: structuredClone(item.update),
          userId: item.userId,
          idempotencyKey: item.key,
          inboxItemId: item.id,
        });
        const operationId = result?.operationId ?? result?.id ?? null;
        const completed = await inbox.markCompleted(item.id, operationId);
        if (completed === false) {
          throw new Error('Telegram inbox item could not be marked completed; retry requires an idempotent domain adapter.');
        }
        return { processed: true, itemId: item.id, operationId };
      } catch (error) {
        await inbox.markPending(item.id, error?.message || 'Domain adapter failed');
        throw error;
      }
    } finally {
      active = false;
    }
  }

  return Object.freeze({ processOne });
}
