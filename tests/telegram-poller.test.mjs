import test from 'node:test';
import assert from 'node:assert/strict';
import { createTelegramPoller } from '../host/telegram-poller.mjs';

function fixture({ updates = [], accept = async () => ({ accepted: true }), offset = null } = {}) {
  let savedOffset = offset;
  let requestedUrl;
  const gate = { accept };
  const offsetStore = {
    async read() { return savedOffset; },
    async write(value) { savedOffset = value; },
  };
  const fetchImpl = async url => {
    requestedUrl = new URL(url);
    const bytes = new TextEncoder().encode(JSON.stringify({ ok: true, result: updates }));
    return {
      ok: true,
      headers: { get(name) { return name.toLowerCase() === 'content-length' ? String(bytes.byteLength) : null; } },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
    };
  };
  return {
    poller: createTelegramPoller({ botToken: 'test-secret-token', gate, offsetStore, fetchImpl, timeoutSeconds: 0 }),
    get offset() { return savedOffset; },
    get requestedUrl() { return requestedUrl; },
  };
}

test('durably checkpoints only after accepted updates have been enqueued', async () => {
  const seen = [];
  const f = fixture({
    updates: [{ update_id: 10 }, { update_id: 11 }],
    accept: async update => {
      seen.push(update.update_id);
      return { accepted: true };
    },
  });
  const result = await f.poller.pollOnce();
  assert.deepEqual(seen, [10, 11]);
  assert.deepEqual(result, { received: 2, accepted: 2, rejected: 0, nextOffset: 12 });
  assert.equal(f.offset, 12);
  assert.equal(f.requestedUrl.searchParams.get('offset'), null);
});

test('does not advance offset when durable enqueue fails', async () => {
  const f = fixture({
    offset: 7,
    updates: [{ update_id: 7 }, { update_id: 8 }],
    accept: async update => {
      if (update.update_id === 8) throw new Error('disk unavailable');
      return { accepted: true };
    },
  });
  await assert.rejects(f.poller.pollOnce(), /disk unavailable/);
  assert.equal(f.offset, 7);
});

test('advances past rejected users and sends persisted offset on next poll', async () => {
  const f = fixture({ updates: [{ update_id: 25 }], accept: async () => ({ accepted: false }) });
  const result = await f.poller.pollOnce();
  assert.equal(result.rejected, 1);
  assert.equal(f.offset, 26);
  await f.poller.pollOnce();
  assert.equal(f.requestedUrl.searchParams.get('offset'), '26');
});

test('rejects invalid configuration and malformed Telegram responses', async () => {
  assert.throws(() => createTelegramPoller({ botToken: '', gate: {}, offsetStore: {} }), /bot token/);
  const f = fixture();
  const bad = createTelegramPoller({
    botToken: 'secret',
    gate: { accept: async () => ({ accepted: true }) },
    offsetStore: { read: async () => null, write: async () => {} },
    fetchImpl: async () => ({ ok: true, async json() { return { ok: false }; } }),
    timeoutSeconds: 0,
  });
  await assert.rejects(bad.pollOnce(), /invalid getUpdates response/);
});


test('rejects a response whose declared content length exceeds the bounded reader limit', async () => {
  const f = fixture();
  const poller = createTelegramPoller({
    botToken: 'test-secret-token',
    gate: { accept: async () => ({ accepted: true }) },
    offsetStore: { read: async () => null, write: async () => {} },
    fetchImpl: async () => ({
      ok: true,
      headers: { get: () => String(1024 * 1024 + 1) },
      body: { cancel: async () => {} },
    }),
    timeoutSeconds: 0,
  });
  await assert.rejects(poller.pollOnce(), /exceeds the allowed size/);
});

test('rejects response bodies that cannot be read with a bounded stream', async () => {
  const poller = createTelegramPoller({
    botToken: 'test-secret-token',
    gate: { accept: async () => ({ accepted: true }) },
    offsetStore: { read: async () => null, write: async () => {} },
    fetchImpl: async () => ({ ok: true, headers: { get: () => null }, async json() { return { ok: true, result: [] }; } }),
    timeoutSeconds: 0,
  });
  await assert.rejects(poller.pollOnce(), /bounded readable body/);
});


test('rejects a streamed body that crosses the byte limit even without content-length', async () => {
  const oversized = new Uint8Array(1024 * 1024 + 1);
  const poller = createTelegramPoller({
    botToken: 'test-secret-token',
    gate: { accept: async () => ({ accepted: true }) },
    offsetStore: { read: async () => 9, write: async () => assert.fail('must not checkpoint') },
    fetchImpl: async () => ({
      ok: true,
      headers: { get: () => null },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(oversized);
          controller.close();
        },
      }),
    }),
    timeoutSeconds: 0,
  });
  await assert.rejects(poller.pollOnce(), /exceeds the allowed size/);
});

test('does not checkpoint when Telegram returns malformed JSON', async () => {
  let checkpointed = false;
  const poller = createTelegramPoller({
    botToken: 'test-secret-token',
    gate: { accept: async () => ({ accepted: true }) },
    offsetStore: { read: async () => 3, write: async () => { checkpointed = true; } },
    fetchImpl: async () => ({
      ok: true,
      headers: { get: () => null },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{broken'));
          controller.close();
        },
      }),
    }),
    timeoutSeconds: 0,
  });
  await assert.rejects(poller.pollOnce(), /invalid JSON/);
  assert.equal(checkpointed, false);
});
