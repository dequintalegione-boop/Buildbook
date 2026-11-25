/** Read a Telegram Bot API body with a hard byte limit. Never buffer via response.text(). */
export const MAX_TELEGRAM_RESPONSE_BYTES = 1024 * 1024;

function cancelWithoutWaiting(operation) {
  try {
    const cancellation = operation?.();
    cancellation?.catch?.(() => {});
  } catch {
    // Cleanup is best-effort; it must not replace the response validation error.
  }
}

export async function readBoundedTelegramJson(response) {
  const declaredLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_TELEGRAM_RESPONSE_BYTES) {
    cancelWithoutWaiting(() => response.body?.cancel?.());
    throw new Error('Telegram response exceeds the allowed size.');
  }
  if (!response.body?.getReader) {
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
        cancelWithoutWaiting(() => reader.cancel());
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
