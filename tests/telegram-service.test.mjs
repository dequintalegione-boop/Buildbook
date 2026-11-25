import test from 'node:test';
import assert from 'node:assert/strict';
import { createTelegramService } from '../host/telegram-service.mjs';

test('runs cycles until stopped and exposes running state', async () => {
  let service;
  let cycles = 0;
  service = createTelegramService({
    runtime: { async runOnce() { return { count: ++cycles }; } },
    intervalMs: 0,
    onCycle() { if (cycles === 3) queueMicrotask(() => service.stop()); },
  });
  const loop = service.start();
  assert.equal(service.running, true);
  await loop;
  assert.equal(cycles, 3);
  assert.equal(service.running, false);
});

test('backs off after errors and resumes cycles', async () => {
  let service;
  let attempts = 0;
  let errors = 0;
  service = createTelegramService({
    runtime: { async runOnce() { attempts += 1; if (attempts === 1) throw new Error('offline'); return {}; } },
    retryBaseMs: 0,
    retryMaxMs: 0,
    intervalMs: 0,
    onError() { errors += 1; if (errors === 1) queueMicrotask(() => service.stop()); },
  });
  await service.start();
  assert.equal(errors, 1);
  assert.equal(attempts, 1);
});

test('validates runtime and retry configuration', () => {
  assert.throws(() => createTelegramService({}), /runtime is required/);
  assert.throws(() => createTelegramService({ runtime: { runOnce() {} }, retryBaseMs: 5, retryMaxMs: 2 }), /at least/);
});

test('stops promptly while waiting between cycles and can be restarted', async () => {
  let cycles = 0;
  const service = createTelegramService({
    runtime: { async runOnce() { cycles += 1; return {}; } },
    intervalMs: 60_000,
  });

  const firstRun = service.start();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cycles, 1);
  await service.stop();
  await firstRun;
  assert.equal(service.running, false);

  const secondRun = service.start();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cycles, 2);
  await service.stop();
  await secondRun;
  assert.equal(service.running, false);
});

test('concurrent start calls share one lifecycle loop', async () => {
  let cycles = 0;
  const service = createTelegramService({
    runtime: { async runOnce() { cycles += 1; return {}; } },
    intervalMs: 60_000,
  });

  const first = service.start();
  const second = service.start();
  assert.equal(first, second);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cycles, 1);
  await service.stop();
  await first;
});


test('observer callback errors do not cause a successful poll to be retried', async () => {
  let service;
  let cycles = 0;
  let observerErrors = 0;
  service = createTelegramService({
    runtime: { async runOnce() { cycles += 1; if (cycles === 2) queueMicrotask(() => service.stop()); return { cycles }; } },
    intervalMs: 0,
    onCycle() { throw new Error('observer failed'); },
    onError(error, context) {
      if (context.phase === 'onCycle') observerErrors += 1;
    },
  });

  await service.start();
  assert.equal(cycles, 2);
  assert.equal(observerErrors, 2);
});

test('does not start runtime when instance lock acquisition fails', async () => {
  let cycles = 0;
  const service = createTelegramService({
    runtime: { async runOnce() { cycles += 1; return {}; } },
    acquireInstanceLock() {
      const error = new Error('already running');
      error.code = 'BUILDBOOK_INSTANCE_LOCKED';
      throw error;
    },
  });
  assert.throws(() => service.start(), /already running/);
  assert.equal(service.running, false);
  assert.equal(cycles, 0);
});

test('releases acquired instance lock after a clean stop', async () => {
  let released = 0;
  const service = createTelegramService({
    runtime: { async runOnce() { return {}; } },
    intervalMs: 60_000,
    acquireInstanceLock() { return () => { released += 1; }; },
  });
  const run = service.start();
  await new Promise(resolve => setImmediate(resolve));
  await service.stop();
  await run;
  assert.equal(released, 1);
});
