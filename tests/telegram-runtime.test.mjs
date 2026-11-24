import test from 'node:test';
import assert from 'node:assert/strict';
import { createTelegramRuntime } from '../host/telegram-runtime.mjs';

test('recovers once, drains existing items, polls, then drains new items sequentially', async () => {
  const calls = [];
  let pending = 2;
  const inbox = {
    async recoverInterrupted() { calls.push('recover'); },
    async stats() { return { pending }; },
  };
  const poller = { async pollOnce() { calls.push('poll'); pending += 1; return { received: 1, accepted: 1 }; } };
  const processor = {
    async processOne() {
      calls.push('process');
      if (!pending) return { processed: false, reason: 'empty' };
      pending -= 1;
      return { processed: true };
    },
  };
  const runtime = createTelegramRuntime({ inbox, poller, processor });
  const first = await runtime.runOnce();
  assert.equal(first.processed, 3);
  assert.deepEqual(calls, ['recover', 'process', 'process', 'process', 'poll', 'process', 'process']);
  calls.length = 0;
  await runtime.runOnce();
  assert.deepEqual(calls, ['process', 'poll', 'process', 'process']);
});

test('drains already accepted updates even when Telegram polling fails', async () => {
  const calls = [];
  let pending = 1;
  const runtime = createTelegramRuntime({
    inbox: {
      async recoverInterrupted() {},
      async stats() { return { pending }; },
    },
    poller: { async pollOnce() { calls.push('poll'); throw new Error('Telegram unavailable'); } },
    processor: {
      async processOne() {
        calls.push('process');
        if (!pending) return { processed: false };
        pending -= 1;
        return { processed: true };
      },
    },
  });

  await assert.rejects(runtime.runOnce(), /Telegram unavailable/);
  assert.deepEqual(calls, ['process', 'process', 'poll']);
});

test('does not poll again while a cycle is active', async () => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const inbox = { async recoverInterrupted() {}, async stats() { return {}; } };
  const runtime = createTelegramRuntime({
    inbox,
    poller: { async pollOnce() { await waiting; return {}; } },
    processor: { async processOne() { return { processed: false }; } },
  });
  const first = runtime.runOnce();
  await assert.rejects(runtime.runOnce(), /already in progress/);
  release();
  await first;
});

test('requires all runtime components', () => {
  assert.throws(() => createTelegramRuntime({}), /durable Telegram inbox/);
});

test('compacts terminal inbox entries only after polling returns a durable checkpoint', async () => {
  const calls = [];
  const runtime = createTelegramRuntime({
    inbox: {
      async recoverInterrupted() {},
      async stats() { return {}; },
      async compactAcknowledged(offset) { calls.push(['compact', offset]); },
    },
    poller: {
      async pollOnce() {
        calls.push(['poll']);
        return { received: 0, accepted: 0, nextOffset: 27 };
      },
    },
    processor: { async processOne() { return { processed: false }; } },
  });

  await runtime.runOnce();
  assert.deepEqual(calls, [['poll'], ['compact', 27]]);
});

test('does not compact inbox records when polling fails before checkpoint confirmation', async () => {
  let compacted = false;
  const runtime = createTelegramRuntime({
    inbox: {
      async recoverInterrupted() {},
      async stats() { return {}; },
      async compactAcknowledged() { compacted = true; },
    },
    poller: { async pollOnce() { throw new Error('checkpoint write failed'); } },
    processor: { async processOne() { return { processed: false }; } },
  });

  await assert.rejects(runtime.runOnce(), /checkpoint write failed/);
  assert.equal(compacted, false);
});
