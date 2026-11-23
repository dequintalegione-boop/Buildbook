/**
 * Telegram long-poll receiver. It advances the Telegram offset only after the
 * update gate has durably accepted every allowlisted update in the batch.
 * Supply a secret bot token from host-only configuration; never from the UI.
 */
export function createTelegramPoller({ botToken, gate, offsetStore, fetchImpl = globalThis.fetch, timeoutSeconds = 25 } = {}) {
  if (typeof botToken !== 'string' || !botToken.trim()) throw new TypeError('Telegram bot token is required.');
  if (!gate || typeof gate.accept !== 'function') throw new TypeError('A Telegram update gate is required.');
  if (!offsetStore || typeof offsetStore.read !== 'function' || typeof offsetStore.write !== 'function') {
    throw new TypeError('A durable Telegram offset store is required.');
  }
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required.');
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 0 || timeoutSeconds > 50) {
    throw new TypeError('Telegram long-poll timeout must be between 0 and 50 seconds.');
  }

  let running = false;

  async function pollOnce({ signal } = {}) {
    if (running) throw new Error('A Telegram polling request is already in progress.');
    running = true;
    try {
      const offset = await offsetStore.read();
      const url = new URL(`https://api.telegram.org/bot${botToken}/getUpdates`);
      url.searchParams.set('timeout', String(timeoutSeconds));
      url.searchParams.set('allowed_updates', JSON.stringify(['message', 'edited_message', 'callback_query', 'inline_query']));
      if (offset !== null) url.searchParams.set('offset', String(offset));

      const response = await fetchImpl(url, { method: 'GET', signal });
      if (!response?.ok) throw new Error(`Telegram getUpdates failed with HTTP ${response?.status ?? 'unknown'}.`);
      const payload = await response.json();
      if (!payload?.ok || !Array.isArray(payload.result)) throw new Error('Telegram returned an invalid getUpdates response.');

      let accepted = 0;
      let rejected = 0;
      let nextOffset = offset;
      for (const update of payload.result) {
        if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0) {
          throw new Error('Telegram returned an invalid update_id.');
        }
        const result = await gate.accept(update);
        if (result.accepted) accepted += 1;
        else rejected += 1;
        nextOffset = Math.max(nextOffset ?? 0, update.update_id + 1);
      }

      // Checkpoint only after all allowed updates have been durably enqueued.
      if (nextOffset !== offset && nextOffset !== null) await offsetStore.write(nextOffset);
      return { received: payload.result.length, accepted, rejected, nextOffset };
    } finally {
      running = false;
    }
  }

  return Object.freeze({ pollOnce });
}
