/**
 * Telegram long-poll receiver. It advances the Telegram offset only after the
 * update gate has durably accepted every allowlisted update in the batch.
 * Supply a secret bot token from host-only configuration; never from the UI.
 */
const MAX_TELEGRAM_RESPONSE_BYTES = 1024 * 1024;

async function readTelegramJson(response) {
  const declaredLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_TELEGRAM_RESPONSE_BYTES) {
    await response.body?.cancel?.().catch(() => {});
    throw new Error('Telegram response exceeds the allowed size.');
  }
  if (!response.body?.getReader) {
    // Do not fall back to response.text(): it buffers an unbounded body before
    // the size check and defeats the response limit on non-standard fetches.
    throw new Error('Telegram response does not expose a bounded readable body.');
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_TELEGRAM_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error('Telegram response exceeds the allowed size.');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total));
    return JSON.parse(text);
  } catch {
    throw new Error('Telegram returned invalid UTF-8 JSON.');
  }
}

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
      if (offset !== null && (!Number.isSafeInteger(offset) || offset < 0)) {
        throw new TypeError('Telegram offset store returned an invalid checkpoint.');
      }

      const url = new URL(`https://api.telegram.org/bot${botToken}/getUpdates`);
      url.searchParams.set('timeout', String(timeoutSeconds));
      // The receiver currently supports only new private text messages.
      // Requesting other update types adds unnecessary input surface and can
      // advance the checkpoint past updates the command gate cannot process.
      url.searchParams.set('allowed_updates', JSON.stringify(['message']));
      if (offset !== null) url.searchParams.set('offset', String(offset));

      const response = await fetchImpl(url, { method: 'GET', signal });
      if (!response?.ok) throw new Error(`Telegram getUpdates failed with HTTP ${response?.status ?? 'unknown'}.`);
      const payload = await readTelegramJson(response);
      if (!payload?.ok || !Array.isArray(payload.result)) throw new Error('Telegram returned an invalid getUpdates response.');
      if (payload.result.length > 1000) throw new Error('Telegram returned too many updates in one batch.');

      let accepted = 0;
      let rejected = 0;
      let nextOffset = offset;
      let previousUpdateId = null;
      for (const update of payload.result) {
        if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0
          || update.update_id >= Number.MAX_SAFE_INTEGER
          || (previousUpdateId !== null && update.update_id <= previousUpdateId)) {
          throw new Error('Telegram returned invalid or unordered update IDs.');
        }
        previousUpdateId = update.update_id;
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
