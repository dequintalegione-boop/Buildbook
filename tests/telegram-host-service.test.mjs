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
    assert.throws(() => createTelegramHostService({ config: config(root) }), /Provide exactly one of applyUpdate or profileStore/);
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
    assert.equal(host.getStatus().running, false);
    assert.equal(host.getStatus().queue, null);
    assert.equal(JSON.stringify(host.getStatus()).includes('secret'), false);
    assert.equal(typeof host.inbox.enqueue, 'function');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('host factory rejects overlapping storage and lock paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'buildbook-host-'));
  try {
    const cfg = config(root);
    cfg.instanceLockPath = cfg.inboxPath;
    assert.throws(() => createTelegramHostService({
      config: cfg,
      async applyUpdate() { return { operationId: 'op-1' }; },
    }), /must be distinct/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('host factory rejects relative lock paths even when config is hand-built', () => {
  const root = mkdtempSync(join(tmpdir(), 'buildbook-host-'));
  try {
    const cfg = config(root);
    cfg.instanceLockPath = 'relative.lock';
    assert.throws(() => createTelegramHostService({
      config: cfg,
      async applyUpdate() { return { operationId: 'op-1' }; },
    }), /must be absolute/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('host factory accepts numeric bot token identity and rejects malformed token syntax', () => {
  const root = mkdtempSync(join(tmpdir(), 'buildbook-host-token-'));
  try {
    const valid = createTelegramHostService({
      config: config(root),
      async applyUpdate() { return { operationId: 'op-1' }; },
    });
    assert.equal(valid.service.running, false);

    const malformed = config(root);
    malformed.botToken = '\\d+:secret';
    assert.throws(() => createTelegramHostService({
      config: malformed,
      async applyUpdate() { return { operationId: 'op-1' }; },
    }), /bot ID must match the bot token identity/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('host factory rejects a bot ID that does not match the token identity', () => {
  const root = mkdtempSync(join(tmpdir(), 'buildbook-host-'));
  try {
    const cfg = config(root);
    cfg.botId = '654321';
    assert.throws(() => createTelegramHostService({
      config: cfg,
      async applyUpdate() { return { operationId: 'op-1' }; },
    }), /bot ID must match the bot token identity/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
