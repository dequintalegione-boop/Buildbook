import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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

test('rejects malformed or duplicate-key durable inbox records on load', async () => {
  await withStore(async file => {
    await writeFile(file, JSON.stringify({ version: 1, items: [null] }), 'utf8');
    const inbox = createInboxStore(file);
    await assert.rejects(inbox.stats(), /corrupt Telegram inbox file/i);
  });
  await withStore(async file => {
    const item = {
      id: 'one', key: 'bot-1:3', botId: 'bot-1', updateId: 3, userId: '1001',
      update: { update_id: 3 }, status: 'pending', attempts: 0,
      receivedAt: new Date().toISOString(), processedAt: null, lastError: null,
    };
    await writeFile(file, JSON.stringify({ version: 1, items: [item, { ...item, id: 'two' }] }), 'utf8');
    const inbox = createInboxStore(file);
    await assert.rejects(inbox.nextPending(), /corrupt Telegram inbox file/i);
  });
});

test('refuses a symlink as the durable inbox file', async () => {
  await withStore(async file => {
    const external = file + '.external';
    await writeFile(external, JSON.stringify({ version: 1, items: [] }), 'utf8');
    try {
      await symlink(external, file);
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return;
      throw error;
    }
    const inbox = createInboxStore(file);
    await assert.rejects(inbox.stats(), /regular file|special file/i);
  });
});

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

test('failed durable enqueue does not poison the in-memory dedupe snapshot', async () => {
  await withStore(async file => {
    const inbox = createInboxStore(file);
    await inbox.stats(); // Load and cache the initial empty snapshot.
    await mkdir(file); // Force atomic rename to fail after the temp write.
    await assert.rejects(
      inbox.enqueue({ botId: 'bot-1', updateId: 13, userId: '1001', update: { message: 'income' } })
    );
    await rm(file, { recursive: true, force: true });
    const retry = await inbox.enqueue({ botId: 'bot-1', updateId: 13, userId: '1001', update: { message: 'income' } });
    assert.equal(retry.inserted, true);
    assert.equal((await inbox.nextPending()).key, 'bot-1:13');
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

test('completed updates purge raw payload but retain dedupe metadata', async () => {
  await withStore(async file => {
    const inbox = createInboxStore(file);
    const { item } = await inbox.enqueue({ botId: 'bot-1', updateId: 9, userId: '1001', update: { message: 'expense', caption: 'private note' } });
    await inbox.markProcessing(item.id);
    await inbox.markCompleted(item.id, 'tx-123');

    assert.equal(await inbox.nextPending(), null);
    assert.equal((await inbox.stats()).completed, 1);

    const reopened = createInboxStore(file);
    const duplicate = await reopened.enqueue({ botId: 'bot-1', updateId: 9, userId: '1001', update: { message: 'expense' } });
    assert.equal(duplicate.inserted, false);
    assert.equal(duplicate.item.update, null);
    assert.equal(duplicate.item.operationId, 'tx-123');
  });
});

test('cannot mark an inbox item completed without a committed operation ID', async () => {
  await withStore(async file => {
    const inbox = createInboxStore(file);
    const { item } = await inbox.enqueue({ botId: 'bot-1', updateId: 11, userId: '1001', update: { message: 'income' } });
    await inbox.markProcessing(item.id);
    await assert.rejects(inbox.markCompleted(item.id, null), /valid committed Buildbook operation ID/);
    assert.equal((await inbox.stats()).processing, 1);
  });
});

test('inbox state transitions reject invalid completion and terminal-state rewrites', async () => {
  await withStore(async file => {
    const inbox = createInboxStore(file);
    const { item } = await inbox.enqueue({ botId: 'bot-1', updateId: 12, userId: '1001', update: { message: 'income' } });
    assert.equal(await inbox.markPending(item.id, 'not processing'), false);
    assert.equal(await inbox.markRejected(item.id, 'not processing'), false);
    assert.equal(await inbox.markCompleted(item.id, 'tx-12'), false);
    assert.equal(await inbox.markProcessing(item.id), true);
    assert.equal(await inbox.markCompleted(item.id, 'tx-12'), true);
    assert.equal(await inbox.markCompleted(item.id, 'tx-other'), false);
    assert.equal(await inbox.markPending(item.id, 'must not reopen'), false);
    assert.equal(await inbox.markRejected(item.id, 'must not rewrite'), false);
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


test('inbox error summaries never persist arbitrary caller text', async () => {
  await withStore(async file => {
    const inbox = createInboxStore(file);
    const { item } = await inbox.enqueue({ botId: 'bot-1', updateId: 14, userId: '1001', update: { message: 'income' } });
    await inbox.markProcessing(item.id);
    await inbox.markPending(item.id, 'token=secret; private amount=9000');
    const pendingFile = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(pendingFile.items[0].lastError, 'Telegram update processing failed; retry scheduled.');
    assert.doesNotMatch(JSON.stringify(pendingFile), /secret|9000/);

    await inbox.markProcessing(item.id);
    await inbox.markRejected(item.id, 'user text with private details');
    const rejectedFile = JSON.parse(await (await import('node:fs/promises')).readFile(file, 'utf8'));
    assert.equal(rejectedFile.items[0].lastError, 'Telegram update rejected by command validation.');
    assert.doesNotMatch(JSON.stringify(rejectedFile), /private details/);
  });
});

test('rejected inbox records are terminal and excluded from pending work', async () => {
  await withStore(async file => {
    const inbox = createInboxStore(file);
    const { item } = await inbox.enqueue({ botId: 'bot-1', updateId: 10, userId: '1001', update: { message: 'tampered' } });
    await inbox.markProcessing(item.id);
    assert.equal(await inbox.markRejected(item.id, 'invalid envelope'), true);
    assert.equal(await inbox.nextPending(), null);
    assert.equal((await inbox.stats()).rejected, 1);
    const reopened = createInboxStore(file);
    assert.equal(await reopened.nextPending(), null);
  });
});
