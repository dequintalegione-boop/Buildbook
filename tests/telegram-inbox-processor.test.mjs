import test from 'node:test';
import assert from 'node:assert/strict';
import { createTelegramInboxProcessor } from '../host/telegram-inbox-processor.mjs';

function makeInbox(item) {
  const state = { item: structuredClone(item), status: 'pending', calls: [] };
  return {
    state,
    async nextPending() { return state.status === 'pending' ? structuredClone(state.item) : null; },
    async markProcessing(id) {
      if (id !== state.item.id || state.status !== 'pending') return false;
      state.status = 'processing';
      state.calls.push('processing');
      return true;
    },
    async markPending(id, message) {
      if (id !== state.item.id || state.status === 'completed') return false;
      state.status = 'pending';
      state.error = message;
      state.calls.push('pending');
      return true;
    },
    async markRejected(id, message) {
      if (id !== state.item.id) return false;
      state.status = 'rejected';
      state.error = message;
      state.calls.push('rejected');
      return true;
    },
    async markCompleted(id, operationId) {
      if (id !== state.item.id) return false;
      state.status = 'completed';
      state.operationId = operationId;
      state.calls.push('completed');
      return true;
    },
  };
}

const sample = {
  id: 'inbox-1',
  botId: 'bot-1',
  key: 'bot-1:44',
  userId: '1001',
  update: { update_id: 44, message: { message_id: 44, from: { id: 1001 }, chat: { id: 1001, type: 'private' }, text: 'income 100' } },
};

test('passes stable idempotency key and completes after adapter succeeds', async () => {
  const inbox = makeInbox(sample);
  let received;
  const processor = createTelegramInboxProcessor({
    inbox,
    async applyUpdate(input) {
      received = input;
      return { operationId: 'operation-7' };
    },
  });
  const result = await processor.processOne();
  assert.equal(received.idempotencyKey, 'bot-1:44');
  assert.equal(received.userId, '1001');
  assert.deepEqual(inbox.state.calls, ['processing', 'completed']);
  assert.equal(inbox.state.operationId, 'operation-7');
  assert.equal(result.processed, true);
});

test('returns failed adapter work to pending for retry', async () => {
  const inbox = makeInbox(sample);
  const processor = createTelegramInboxProcessor({
    inbox,
    async applyUpdate() {
      const error = new Error('token=secret-value; user wrote private financial details');
      error.code = 'TOKEN_SECRET_123';
      throw error;
    },
  });
  await assert.rejects(processor.processOne(), /token=secret-value/);
  assert.equal(inbox.state.status, 'pending');
  assert.equal(inbox.state.error, 'Canonical adapter failed; retry scheduled.');
  assert.equal(inbox.state.error.includes('secret-value'), false);
  assert.equal(inbox.state.error.includes('private financial details'), false);
  assert.equal(inbox.state.error.includes('TOKEN_SECRET_123'), false);
  assert.deepEqual(inbox.state.calls, ['processing', 'pending']);
});

test('does not call adapter when inbox is empty or claim fails', async () => {
  let called = false;
  const empty = {
    async nextPending() { return null; },
    async markProcessing() { return false; },
    async markPending() {},
    async markCompleted() {},
    async markRejected() {},
  };
  const processor = createTelegramInboxProcessor({ inbox: empty, async applyUpdate() { called = true; } });
  assert.deepEqual(await processor.processOne(), { processed: false, reason: 'empty' });
  assert.equal(called, false);
});

test('rejects missing canonical adapter', () => {
  assert.throws(() => createTelegramInboxProcessor({ inbox: {} }), /durable Telegram inbox/);
});


test('keeps the inbox pending when adapter returns no committed operation ID', async () => {
  const inbox = makeInbox(sample);
  const processor = createTelegramInboxProcessor({ inbox, async applyUpdate() { return { ok: true }; } });
  await assert.rejects(processor.processOne(), /valid committed Buildbook operation ID/);
  assert.equal(inbox.state.status, 'pending');
  assert.deepEqual(inbox.state.calls, ['processing', 'pending']);
});

test('does not report success when durable completion fails', async () => {
  const inbox = makeInbox(sample);
  inbox.markCompleted = async () => false;
  const processor = createTelegramInboxProcessor({ inbox, async applyUpdate() { return { operationId: 'operation-8' }; } });
  await assert.rejects(processor.processOne(), /could not be marked completed/);
  assert.equal(inbox.state.status, 'pending');
});

test('rejects malformed or tampered inbox payload before calling domain adapter', async () => {
  const tampered = structuredClone(sample);
  tampered.update.message.chat.id = 2002;
  const inbox = makeInbox(tampered);
  let called = false;
  const processor = createTelegramInboxProcessor({
    inbox,
    async applyUpdate() { called = true; return { operationId: 'should-not-exist' }; },
  });
  await assert.rejects(processor.processOne(), /private-text command validation/);
  assert.equal(called, false);
  assert.equal(inbox.state.status, 'rejected');
});


test('rejects non-canonical numeric identity aliases in persisted inbox records', async () => {
  const tampered = structuredClone(sample);
  tampered.userId = '01001';
  const inbox = makeInbox(tampered);
  let called = false;
  const processor = createTelegramInboxProcessor({
    inbox,
    async applyUpdate() { called = true; return { operationId: 'should-not-exist' }; },
  });
  await assert.rejects(processor.processOne(), /private-text command validation/);
  assert.equal(called, false);
  assert.equal(inbox.state.status, 'rejected');
});

test('adapter receives only the normalized private-text envelope', async () => {
  const tampered = structuredClone(sample);
  tampered.update.privateMetadata = 'must-not-forward';
  tampered.update.message.extra = { secret: 'must-not-forward' };
  const inbox = makeInbox(tampered);
  let received;
  const processor = createTelegramInboxProcessor({
    inbox,
    async applyUpdate(input) { received = input.update; return { operationId: 'operation-safe' }; },
  });
  await processor.processOne();
  assert.deepEqual(received, {
    update_id: 44,
    message: {
      message_id: 44,
      from: { id: 1001 },
      chat: { id: 1001, type: 'private' },
      text: 'income 100',
    },
  });
  assert.equal(JSON.stringify(received).includes('must-not-forward'), false);
});

test('malformed inbox items are quarantined rather than retried', async () => {
  const tampered = structuredClone(sample);
  tampered.update.message.chat.id = 2002;
  const inbox = makeInbox(tampered);
  const processor = createTelegramInboxProcessor({ inbox, async applyUpdate() { assert.fail('adapter must not run'); } });
  await assert.rejects(processor.processOne(), /private-text command validation/);
  assert.equal(inbox.state.status, 'rejected');
  assert.deepEqual(inbox.state.calls, ['processing', 'rejected']);
});


test('retries after canonical commit but before inbox completion without duplicating the finance operation', async () => {
  const inbox = makeInbox(sample);
  const profileStore = {
    revision: 0,
    profile: { state: { tx: [] } },
    async read() {
      return { revision: this.revision, profile: structuredClone(this.profile) };
    },
    async write(next, expectedRevision) {
      assert.equal(expectedRevision, this.revision);
      this.profile = structuredClone(next);
      return ++this.revision;
    },
  };
  const { createProfileFinanceAdapter } = await import('../host/profile-finance-adapter.mjs');
  let buildCalls = 0;
  const applyUpdate = createProfileFinanceAdapter({
    profileStore,
    async buildTransaction() {
      buildCalls++;
      return {
        kind: 'i',
        date: '2026-11-23',
        amount: 100,
        desc: 'Telegram income',
        cat: 'Заработок',
        grp: 'Доходы',
        acc: 'Наличные',
      };
    },
  });
  const markCompleted = inbox.markCompleted.bind(inbox);
  let completionAttempts = 0;
  inbox.markCompleted = async (...args) => {
    completionAttempts++;
    if (completionAttempts === 1) return false;
    return markCompleted(...args);
  };
  const processor = createTelegramInboxProcessor({ inbox, applyUpdate });

  await assert.rejects(processor.processOne(), /could not be marked completed/);
  assert.equal(profileStore.profile.state.tx.length, 1);
  assert.equal(inbox.state.status, 'pending');

  const retried = await processor.processOne();
  assert.equal(retried.processed, true);
  assert.equal(profileStore.profile.state.tx.length, 1);
  assert.equal(buildCalls, 1);
  assert.equal(inbox.state.status, 'completed');
  assert.equal(inbox.state.operationId, profileStore.profile.state.tx[0].id);
});
