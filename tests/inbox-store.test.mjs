import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInboxStore } from '../host/inbox-store.mjs';

async function withStore(run) {
  const directory = await mkdtemp(join(tmpdir(), 'buildbook-inbox-'));
  try {
    await run(join(directory, 'inbox.json'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('enqueue is durable and duplicate Telegram updates are idempotent', async () => {
  await withStore(async file => {
    const inbox = createInboxStore(file);
    const first = await inbox.enqueue({ botId: 'bot-1', updateId: 42, userId: '1001', update: { message: 'income' } });
    const duplicate = await inbox.enqueue({ botId: 'bot-1', updateId: 42, userId: '1001', update: { message: 'income' } });
    assert.equal(first.inserted, true);
    assert.equal(duplicate.inserted, false);
    assert.equal((await inbox.stats()).total, 1);

    const reopened = createInboxStore(file);
    assert.equal((await reopened.nextPending()).key, 'bot-1:42');
  });
});

test('failed processing returns to pending and can be retried', async () => {
  await withStore(async file => {
    const inbox = createInboxStore(file);
    const { item } = await inbox.enqueue({ botId: 'bot-1', updateId: 7, userId: '1001', update: { message: 'expense' } });
    assert.equal(await inbox.markProcessing(item.id), true);
    assert.equal(await inbox.markPending(item.id, 'storage unavailable'), true);
    assert.equal((await inbox.nextPending()).id, item.id);
    assert.equal((await inbox.stats()).pending, 1);
  });
});

test('interrupted processing is recovered after service restart', async () => {
  await withStore(async file => {
    const inbox = createInboxStore(file);
    const { item } = await inbox.enqueue({ botId: 'bot-1', updateId: 8, userId: '1001', update: { message: 'income' } });
    await inbox.markProcessing(item.id);

    const restarted = createInboxStore(file);
    assert.equal(await restarted.recoverInterrupted(), 1);
    assert.equal((await restarted.nextPending()).id, item.id);
  });
});

test('completed updates are not returned for processing again', async () => {
  await withStore(async file => {
    const inbox = createInboxStore(file);
    const { item } = await inbox.enqueue({ botId: 'bot-1', updateId: 9, userId: '1001', update: { message: 'expense' } });
    await inbox.markProcessing(item.id);
    await inbox.markCompleted(item.id, 'tx-123');
    assert.equal(await inbox.nextPending(), null);
    assert.equal((await inbox.stats()).completed, 1);
  });
});

test('invalid sender IDs and update IDs are rejected', async () => {
  await withStore(async file => {
    const inbox = createInboxStore(file);
    await assert.rejects(inbox.enqueue({ botId: 'bot-1', updateId: 'not-a-number', userId: '1001', update: {} }), /numeric Telegram updateId/);
    await assert.rejects(inbox.enqueue({ botId: 'bot-1', updateId: 1, userId: 'not-a-number', update: {} }), /numeric Telegram userId/);
  });
});
