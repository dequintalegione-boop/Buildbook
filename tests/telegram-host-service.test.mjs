import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTelegramHostService } from '../host/telegram-host-service.mjs';

function config(root) {
  return {
    botToken: '123456:secret',
    botId: '123456',
    allowedUserIds: ['1001'],
    inboxPath: join(root, 'inbox.json'),
    offsetPath: join(root, 'offset.json'),
    instanceLockPath: join(root, 'service.lock'),
    timeoutSeconds: 0,
    intervalMs: 0,
    retryBaseMs: 100,
    retryMaxMs: 1000,
  };
}

test('host factory refuses to start without canonical domain adapter', () => {
  const root = mkdtempSync(join(tmpdir(), 'buildbook-host-'));
  try {
    assert.throws(() => createTelegramHostService({ config: config(root) }), /canonical Buildbook finance adapter/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('host factory composes service and durable inbox without starting network polling', () => {
  const root = mkdtempSync(join(tmpdir(), 'buildbook-host-'));
  try {
    const host = createTelegramHostService({
      config: config(root),
      async applyUpdate() { return { operationId: 'op-1' }; },
      fetchImpl() { throw new Error('network must not be called during construction'); },
    });
    assert.equal(typeof host.service.start, 'function');
    assert.equal(host.service.running, false);
    assert.equal(typeof host.inbox.enqueue, 'function');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
