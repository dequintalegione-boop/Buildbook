import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { installTelegramHostLifecycle } from '../host/telegram-host-lifecycle.mjs';

function fixture() {
  const processRef = new EventEmitter();
  let starts = 0;
  let stops = 0;
  const host = { service: {
    start() { starts += 1; return new Promise(() => {}); },
    async stop() { stops += 1; },
  } };
  return { processRef, host, counts: () => ({ starts, stops }) };
}

test('lifecycle registers signals before starting and starts only once', () => {
  const { processRef, host, counts } = fixture();
  const lifecycle = installTelegramHostLifecycle({ host, processRef });
  lifecycle.start();
  lifecycle.start();
  assert.deepEqual(counts(), { starts: 1, stops: 0 });
  assert.equal(processRef.listenerCount('SIGINT'), 1);
  assert.equal(processRef.listenerCount('SIGTERM'), 1);
});

test('shutdown is idempotent and removes signal handlers', async () => {
  const { processRef, host, counts } = fixture();
  const lifecycle = installTelegramHostLifecycle({ host, processRef });
  lifecycle.start();
  await Promise.all([lifecycle.stop('manual'), lifecycle.stop('duplicate')]);
  assert.deepEqual(counts(), { starts: 1, stops: 1 });
  assert.equal(processRef.listenerCount('SIGINT'), 0);
  assert.equal(processRef.listenerCount('SIGTERM'), 0);
  assert.equal(lifecycle.running, false);
});

test('service loop rejection is reported without an unhandled rejection', async () => {
  const processRef = new EventEmitter();
  const reported = [];
  const host = { service: {
    start() { return Promise.reject(new Error('loop failed')); },
    async stop() {},
  } };
  const lifecycle = installTelegramHostLifecycle({
    host,
    processRef,
    onError(error, context) { reported.push([error.message, context.phase]); },
  });
  lifecycle.start();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(reported, [['loop failed', 'service-loop']]);
});
