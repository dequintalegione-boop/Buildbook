import { readBoundedTelegramJson } from './telegram-response.mjs';

/**
 * Telegram long-poll receiver. It advances the Telegram offset only after the
 * update gate has durably accepted every allowlisted update in the batch.
 * Supply a secret bot token from host-only configuration; never from the UI.
 */

export function createTelegramPoller({ botToken, gate, offsetStore, fetchImpl = globalThis.fetch, timeoutSeconds = 25, requestTimeoutMs = Math.max(15_000, (timeoutSeconds + 10) * 1000) } = {}) {
  if (typeof botToken !== 'string' || !botToken.trim()) throw new TypeError('Telegram bot token is required.');
  if (!gate || typeof gate.accept !== 'function') throw new TypeError('A Telegram update gate is required.');
  if (!offsetStore || typeof offsetStore.read !== 'function' || typeof offsetStore.write !== 'function') {
    throw new TypeError('A durable Telegram offset store is required.');
  }
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required.');
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 0 || timeoutSeconds > 50) {
    throw new TypeError('Telegram long-poll timeout must be between 0 and 50 seconds.');
  }
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 120_000) {
    throw new TypeError('Telegram request timeout must be an integer between 1 and 120000 milliseconds.');
  }

  let running = false;

  async function readCheckpoint() {
    const offset = await offsetStore.read();
    if (offset !== null && (!Number.isSafeInteger(offset) || offset < 0)) {
      throw new TypeError('Telegram offset store returned an invalid checkpoint.');
    }
    return offset;
  }

  async function pollOnce({ signal } = {}) {
    if (running) throw new Error('A Telegram polling request is already in progress.');
    running = true;
    try {
      const offset = await readCheckpoint();

      const url = new URL(`https://api.telegram.org/bot${botToken}/getUpdates`);
      url.searchParams.set('timeout', String(timeoutSeconds));
      // The receiver currently supports only new private text messages.
      // Requesting other update types adds unnecessary input surface and can
      // advance the checkpoint past updates the command gate cannot process.
      url.searchParams.set('allowed_updates', JSON.stringify(['message']));
      if (offset !== null) url.searchParams.set('offset', String(offset));

      const controller = new AbortController();
      let timedOut = false;
      const abortFromCaller = () => controller.abort(signal.reason || new Error('Telegram polling was aborted.'));
      if (signal?.aborted) abortFromCaller();
      else signal?.addEventListener('abort', abortFromCaller, { once: true });
      let rejectTimeout;
      const timeoutPromise = new Promise((resolve, reject) => {
        rejectTimeout = reject;
      });
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error('Telegram request timed out.'));
        const timeoutError = new Error('Telegram getUpdates request timed out.');
        timeoutError.code = 'TELEGRAM_POLL_TIMEOUT';
        rejectTimeout(timeoutError);
      }, requestTimeoutMs);

      let payload;
      try {
        const request = (async () => {
          let response;
          try {
            response = await fetchImpl(url, { method: 'GET', signal: controller.signal });
          } catch (error) {
            if (timedOut) {
              const timeoutError = new Error('Telegram getUpdates request timed out.');
              timeoutError.code = 'TELEGRAM_POLL_TIMEOUT';
              throw timeoutError;
            }
            if (signal?.aborted) throw signal.reason || new Error('Telegram polling was aborted.');
            // Fetch errors can contain the request URL, which includes the bot token.
            const requestError = new Error('Telegram getUpdates request failed.');
            requestError.code = 'TELEGRAM_POLL_FAILED';
            throw requestError;
          }
          // Read even non-2xx responses through the same byte limit: Telegram
          // communicates flood-control retry_after in the bounded JSON body.
          const body = await readBoundedTelegramJson(response);
          if (!response?.ok || body?.ok === false) {
            const error = new Error('Telegram returned an invalid getUpdates response (HTTP/API error).');
            error.code = response?.status === 429 ? 'TELEGRAM_RATE_LIMITED'
              : response?.status === 401 || response?.status === 403 ? 'TELEGRAM_AUTH_FAILED'
                : 'TELEGRAM_HTTP_ERROR';
            const retryAfter = body?.parameters?.retry_after;
            if (Number.isSafeInteger(retryAfter) && retryAfter > 0) {
              error.retryAfterMs = Math.min(retryAfter, 3600) * 1000;
            }
            throw error;
          }
          // The deadline covers both fetch and bounded body consumption; abort alone
          // is insufficient if a custom stream or transport ignores cancellation.
          return body;
        })();
        payload = await Promise.race([request, timeoutPromise]);
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abortFromCaller);
      }

      if (!payload?.ok || !Array.isArray(payload.result)) throw new Error('Telegram returned an invalid getUpdates response.');
      if (payload.result.length > 1000) throw new Error('Telegram returned too many updates in one batch.');

      let accepted = 0;
      let rejected = 0;
      let nextOffset = offset;
      let previousUpdateId = null;
      for (const update of payload.result) {
        if (signal?.aborted) throw signal.reason || new Error('Telegram polling was aborted.');
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

      // An abort after enqueue but before checkpoint intentionally causes replay;
      // the durable inbox must make that replay idempotent.
      if (signal?.aborted) throw signal.reason || new Error('Telegram polling was aborted.');
      // Checkpoint only after all allowed updates have been durably enqueued.
      if (nextOffset !== offset && nextOffset !== null) await offsetStore.write(nextOffset);
      return { received: payload.result.length, accepted, rejected, nextOffset };
    } finally {
      running = false;
    }
  }

  return Object.freeze({ pollOnce, readCheckpoint });
}
