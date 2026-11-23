import test from 'node:test';
import assert from 'node:assert/strict';
import { createTelegramRuntime } from '../host/telegram-runtime.mjs';

test('recovers once, polls, then drains accepted inbox items sequentially', async () => {
  const calls = [];
  let pending = 2;
  const inbox = {
    async recoverInterrupted() { calls.push('recover'); },
    async stats() { return { pending }; },
  };
  const poller = { async pollOnce() { calls.push('poll'); return { received: 2, accepted: 2 }; } };
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
  assert.equal(first.processed, 2);
  assert.deepEqual(calls, ['recover', 'poll', 'process', 'process', 'process']);
  calls.length = 0;
  await runtime.runOnce();
  assert.deepEqual(calls, ['poll', 'process']);
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
