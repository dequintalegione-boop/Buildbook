import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_TELEGRAM_RESPONSE_BYTES, readBoundedTelegramJson } from '../host/telegram-response.mjs';

test('oversized declared Telegram response is rejected without waiting for body cancellation', async () => {
  let cancellationStarted = false;
  const response = {
    headers: { get: () => String(MAX_TELEGRAM_RESPONSE_BYTES + 1) },
    body: {
      cancel() {
        cancellationStarted = true;
        return new Promise(() => {});
      },
    },
  };

  await assert.rejects(
    readBoundedTelegramJson(response),
    /exceeds the allowed size/,
  );
  assert.equal(cancellationStarted, true);
});

test('oversized streamed Telegram response is rejected without waiting for reader cancellation', async () => {
  let cancellationStarted = false;
  const reader = {
    async read() {
      return { done: false, value: new Uint8Array(MAX_TELEGRAM_RESPONSE_BYTES + 1) };
    },
    cancel() {
      cancellationStarted = true;
      return new Promise(() => {});
    },
    releaseLock() {},
  };
  const response = {
    headers: { get: () => null },
    body: { getReader: () => reader },
  };

  await assert.rejects(
    readBoundedTelegramJson(response),
    /exceeds the allowed size/,
  );
  assert.equal(cancellationStarted, true);
});
