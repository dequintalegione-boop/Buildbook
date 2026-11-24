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

test('requires an absolute durable inbox path', () => {
  assert.throws(() => createInboxStore('relative/inbox.json'), /path must be absolute/i);
});

test('treats only a missing inbox path as an empty queue', async () => {
  await withStore(async file => {
    const missing = createInboxStore(join(file + '.missing-parent', 'not-created', 'inbox.json'));
    assert.equal((await missing.stats()).total, 0);

    const directoryPath = file + '.directory';
    await mkdir(directoryPath);
    const directoryInbox = createInboxStore(directoryPath);
    await assert.rejects(directoryInbox.stats(), /regular file|special file/i);
  });
});

test('rejects malformed or duplicate-key durable inbox records on load', async () => {
  await withStore(async file => {
    await writeFile(file, JSON.stringify({ version: 1, items: [null] }), 'utf8');
    const inbox = createInboxStore(file);
    await assert.rejects(inbox.stats(), /corrupt Telegram inbox file/i);
  });
  await withStore(async file => {
    const item = {
      id: 'one', key: '123456:3', botId: '123456', updateId: 3, userId: '1001',
      update: { update_id: 3 }, status: 'pending', attempts: 0,
      receivedAt: new Date().toISOString(), processedAt: null, lastError: null,
    };
    await writeFile(file, JSON.stringify({ version: 1, items: [item, { ...item, id: 'two' }] }), 'utf8');
    const inbox = createInboxStore(file);
    await assert.rejects(inbox.nextPending(), /corrupt Telegram inbox file/i);
  });
});

test('retries loading after a transient or repaired inbox read failure', async () => {
  await withStore(async file => {
    await writeFile(file, '{ invalid json', 'utf8');
    const inbox = createInboxStore(file);
    await assert.rejects(inbox.stats(), /JSON|Unexpected/i);

    await writeFile(file, JSON.stringify({ version: 1, items: [] }), 'utf8');
    assert.equal((await inbox.stats()).total, 0);
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
    const first = await inbox.enqueue({ botId: '123456', updateId: 42, userId: '1001', update: { update_id: 42, message: { text: 'income' } } });
    const duplicate = await inbox.enqueue({ botId: '123456', updateId: 42, userId: '1001', update: { update_id: 42, message: { text: 'income' } } });
    assert.equal(first.inserted, true);
    assert.equal(duplicate.inserted, false);
    assert.equal((await inbox.stats()).total, 1);

    const reopened = createInboxStore(file);
    assert.equal((await reopened.nextPending()).key, '123456:42');
  });
});

test('failed durable enqueue does not poison the in-memory dedupe snapshot', async () => {
  await withStore(async file => {
    const inbox = createInboxStore(file);
    await inbox.stats(); // Load and cache the initial empty snapshot.
    await mkdir(file); // Force atomic rename to fail after the temp write.
    await assert.rejects(
      inbox.enqueue({ botId: '123456', updateId: 13, userId: '1001', update: { update_id: 13, message: { text: 'income' } } })
    );
    await rm(file, { recursive: true, force: true });
    const receivedAt = new Date().toISOString();
    const externalItem = {
      id: 'external-item', key: '123456:12', botId: '123456', updateId: 12, userId: '1001',
      update: { update_id: 12, message: { text: 'other update' } }, status: 'pending', attempts: 0,
      receivedAt, processedAt: null, lastError: null,
    };
    await writeFile(file, JSON.stringify({ version: 1, items: [externalItem] }), 'utf8');
    const retry = await inbox.enqueue({ botId: '123456', updateId: 13, userId: '1001', update: { update_id: 13, message: { text: 'income' } } });
    assert.equal(retry.inserted, true);
    assert.equal((await inbox.nextPending()).key, '123456:12');
    const persisted = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(persisted.items.map(item => item.key), ['123456:12', '123456:13']);
  });
});

test('failed processing returns to pending and can be retried', async () => {
  await withStore(async file => {
    const inbox = createInboxStore(file);
    const { item } = await inbox.enqueue({ botId: '123456', updateId: 7, userId: '1001', update: { update_id: 7, message: { text: 'expense' } } });
    assert.equal(await inbox.markProcessing(item.id), true);
    assert.equal(await inbox.markPending(item.id, 'storage unavailable'), true);
    assert.equal((await inbox.nextPending()).id, item.id);
    assert.equal((await inbox.stats()).pending, 1);
  });
});

test('interrupted processing is recovered after service restart', async () => {
  await withStore(async file => {
    const inbox = createInboxStore(file);
    const { item } = await inbox.enqueue({ botId: '123456', updateId: 8, userId: '1001', update: { update_id: 8, message: { text: 'income' } } });
    await inbox.markProcessing(item.id);

    const restarted = createInboxStore(file);
    assert.equal(await restarted.recoverInterrupted(), 1);
    assert.equal((await restarted.nextPending()).id, item.id);
  });
});

test('completed updates purge raw payload but retain dedupe metadata', async () => {
  await withStore(async file => {
    const inbox = createInboxStore(file);
    const { item } = await inbox.enqueue({ botId: '123456', updateId: 9, userId: '1001', update: { update_id: 9, message: { text: 'expense', caption: 'private note' } } });
    await inbox.markProcessing(item.id);
    await inbox.markCompleted(item.id, 'tx-123');

    assert.equal(await inbox.nextPending(), null);
    assert.equal((await inbox.stats()).completed, 1);

    const reopened = createInboxStore(file);
    const duplicate = await reopened.enqueue({ botId: '123456', updateId: 9, userId: '1001', update: { update_id: 9, message: { text: 'expense' } } });
    assert.equal(duplicate.inserted, false);
    assert.equal(duplicate.item.update, null);
    assert.equal(duplicate.item.operationId, 'tx-123');
  });
});

test('cannot mark an inbox item completed without a committed operation ID', async () => {
  await withStore(async file => {
    const inbox = createInboxStore(file);
    const { item } = await inbox.enqueue({ botId: '123456', updateId: 11, userId: '1001', update: { update_id: 11, message: { text: 'income' } } });
    await inbox.markProcessing(item.id);
    await assert.rejects(inbox.markCompleted(item.id, null), /valid committed Buildbook operation ID/);
    assert.equal((await inbox.stats()).processing, 1);
  });
});

test('inbox state transitions reject invalid completion and terminal-state rewrites', async () => {
  await withStore(async file => {
    const inbox = createInboxStore(file);
    const { item } = await inbox.enqueue({ botId: '123456', updateId: 12, userId: '1001', update: { update_id: 12, message: { text: 'income' } } });
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
    await assert.rejects(inbox.enqueue({ botId: '123456', updateId: 'not-a-number', userId: '1001', update: {} }), /numeric Telegram updateId/);
    await assert.rejects(inbox.enqueue({ botId: '123456', updateId: 1, userId: 'not-a-number', update: {} }), /numeric Telegram userId/);
  });
});


test('inbox error summaries never persist arbitrary caller text', async () => {
  await withStore(async file => {
    const inbox = createInboxStore(file);
    const { item } = await inbox.enqueue({ botId: '123456', updateId: 14, userId: '1001', update: { update_id: 14, message: { text: 'income' } } });
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
    const { item } = await inbox.enqueue({ botId: '123456', updateId: 10, userId: '1001', update: { update_id: 10, message: { text: 'tampered' } } });
    await inbox.markProcessing(item.id);
    assert.equal(await inbox.markRejected(item.id, 'invalid envelope'), true);
    assert.equal(await inbox.nextPending(), null);
    assert.equal((await inbox.stats()).rejected, 1);
    const reopened = createInboxStore(file);
    assert.equal(await reopened.nextPending(), null);
  });
});

test('compacts only terminal inbox records below the durable Telegram checkpoint', async () => {
  await withStore(async file => {
    const inbox = createInboxStore(file);
    const enqueue = updateId => inbox.enqueue({
      botId: '123456',
      updateId,
      userId: '1001',
      update: { update_id: updateId, message: { text: 'income' } },
    });
    const completedOld = (await enqueue(3)).item;
    const rejectedOld = (await enqueue(4)).item;
    await enqueue(5);
    const completedNew = (await enqueue(8)).item;

    await inbox.markProcessing(completedOld.id);
    await inbox.markCompleted(completedOld.id, 'tx-3');
    await inbox.markProcessing(rejectedOld.id);
    await inbox.markRejected(rejectedOld.id, 'invalid');
    await inbox.markProcessing(completedNew.id);
    await inbox.markCompleted(completedNew.id, 'tx-8');

    assert.equal(await inbox.compactAcknowledged(5), 2);
    assert.deepEqual(await inbox.stats(), {
      total: 2, pending: 1, processing: 0, completed: 1, rejected: 0,
    });
    assert.equal(await inbox.compactAcknowledged(5), 0);

    const reopened = createInboxStore(file);
    assert.equal((await reopened.nextPending()).updateId, 5);
    assert.equal((await reopened.stats()).completed, 1);
  });
});
