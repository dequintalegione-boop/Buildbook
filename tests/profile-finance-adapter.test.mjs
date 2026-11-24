import test from 'node:test';
import assert from 'node:assert/strict';
import { createProfileFinanceAdapter } from '../host/profile-finance-adapter.mjs';

function createStore(initial = { state: { tx: [] } }) {
  let revision = 0;
  let profile = structuredClone(initial);
  return {
    async read() {
      return { revision, profile: structuredClone(profile) };
    },
    async write(next, expectedRevision) {
      if (expectedRevision !== revision) {
        const error = new Error('stale revision');
        error.code = 'BUILD_BOOK_STORAGE_CONFLICT';
        error.currentRevision = revision;
        throw error;
      }
      profile = structuredClone(next);
      return ++revision;
    },
    snapshot() {
      return { revision, profile: structuredClone(profile) };
    },
  };
}

function transaction(overrides = {}) {
  return {
    kind: 'e',
    date: '2026-11-23',
    amount: 12.5,
    desc: 'Кофе',
    cat: 'Еда',
    grp: 'Расходы',
    acc: 'Наличные',
    ...overrides,
  };
}

test('commits transaction and per-bot replay checkpoint in one canonical revision', async () => {
  const store = createStore();
  const apply = createProfileFinanceAdapter({
    profileStore: store,
    buildTransaction: async () => transaction({ id: 'tx-1' }),
  });

  const result = await apply({ update: { text: 'расход кофе' }, idempotencyKey: '123:7' });
  const snapshot = store.snapshot();

  assert.deepEqual(result, { operationId: 'tx-1', revision: 1, duplicate: false });
  assert.equal(snapshot.profile.state.tx.length, 1);
  assert.equal(snapshot.profile.state.tx[0].id, 'tx-1');
  assert.deepEqual(snapshot.profile.telegramOperationCheckpoints, [{ botId: '123', updateId: 7 }]);
  assert.equal(Object.hasOwn(snapshot.profile, 'telegramOperations'), false);
});

test('returns the prior operation for a replay without calling the builder or writing', async () => {
  const store = createStore({
    state: { tx: [{ ...transaction(), id: 'saved-id' }] },
    telegramOperations: [{ key: '123:9', operationId: 'saved-id' }],
  });
  let buildCalls = 0;
  const apply = createProfileFinanceAdapter({
    profileStore: store,
    buildTransaction: async () => {
      buildCalls++;
      return transaction({ id: 'new-id' });
    },
  });

  const result = await apply({ update: {}, idempotencyKey: '123:9' });
  assert.deepEqual(result, { operationId: 'saved-id', duplicate: true });
  assert.equal(buildCalls, 0);
  assert.equal(store.snapshot().revision, 0);
});

test('retries a compare-and-swap conflict and rechecks idempotency against fresh state', async () => {
  let revision = 0;
  let profile = { state: { tx: [] } };
  let writes = 0;
  const store = {
    async read() { return { revision, profile: structuredClone(profile) }; },
    async write(next, expected) {
      writes++;
      if (writes === 1) {
        profile.telegramOperations = [{ key: '123:11', operationId: 'already-committed' }];
        revision++;
        const error = new Error('concurrent commit');
        error.code = 'BUILD_BOOK_STORAGE_CONFLICT';
        throw error;
      }
      assert.equal(expected, revision);
      profile = structuredClone(next);
      return ++revision;
    },
  };
  const apply = createProfileFinanceAdapter({
    profileStore: store,
    buildTransaction: async () => transaction({ id: 'must-not-be-built-after-replay' }),
  });

  const result = await apply({ update: {}, idempotencyKey: '123:11' });
  assert.deepEqual(result, { operationId: 'already-committed', duplicate: true });
  assert.equal(writes, 1);
});

test('rejects invalid transaction data without changing the canonical profile', async () => {
  const store = createStore();
  const apply = createProfileFinanceAdapter({
    profileStore: store,
    buildTransaction: async () => transaction({ amount: -5 }),
  });

  await assert.rejects(
    apply({ update: {}, idempotencyKey: '123:12' }),
    error => error.code === 'INVALID_BUILD_BOOK_TRANSACTION',
  );
  assert.equal(store.snapshot().revision, 0);
  assert.deepEqual(store.snapshot().profile.state.tx, []);
});

test('rejects missing finance state and malformed idempotency keys', async () => {
  const noFinance = createProfileFinanceAdapter({
    profileStore: createStore({ state: {} }),
    buildTransaction: async () => transaction(),
  });
  await assert.rejects(
    noFinance({ update: {}, idempotencyKey: '123:1' }),
    error => error.code === 'BUILD_BOOK_FINANCE_STATE_UNAVAILABLE',
  );

  const apply = createProfileFinanceAdapter({
    profileStore: createStore(),
    buildTransaction: async () => transaction(),
  });
  await assert.rejects(
    apply({ update: {}, idempotencyKey: '0:1' }),
    error => error.code === 'INVALID_TELEGRAM_IDEMPOTENCY_KEY',
  );
});

test('advances a per-bot replay checkpoint without growing the legacy key ledger', async () => {
  const store = createStore();
  let builds = 0;
  const apply = createProfileFinanceAdapter({
    profileStore: store,
    buildTransaction: async () => transaction({ id: `tx-${++builds}` }),
  });

  const first = await apply({ update: {}, idempotencyKey: '123:21' });
  const replay = await apply({ update: {}, idempotencyKey: '123:21' });
  const olderReplay = await apply({ update: {}, idempotencyKey: '123:20' });
  const second = await apply({ update: {}, idempotencyKey: '123:22' });
  const snapshot = store.snapshot();

  assert.equal(first.duplicate, false);
  assert.deepEqual(replay, { operationId: 'telegram-replay:123:21', duplicate: true });
  assert.deepEqual(olderReplay, { operationId: 'telegram-replay:123:20', duplicate: true });
  assert.equal(second.duplicate, false);
  assert.deepEqual(snapshot.profile.state.tx.map(item => item.id), ['tx-1', 'tx-2']);
  assert.deepEqual(snapshot.profile.telegramOperationCheckpoints, [{ botId: '123', updateId: 22 }]);
  assert.equal(Object.hasOwn(snapshot.profile, 'telegramOperations'), false);
  assert.equal(builds, 2);
});

test('derives a checkpoint from legacy keys and preserves exact legacy replay IDs', async () => {
  const store = createStore({
    state: { tx: [{ ...transaction(), id: 'legacy-1' }, { ...transaction(), id: 'legacy-2' }] },
    telegramOperations: [
      { key: '123:31', operationId: 'legacy-1' },
      { key: '123:32', operationId: 'legacy-2' },
    ],
  });
  const apply = createProfileFinanceAdapter({
    profileStore: store,
    buildTransaction: async () => transaction({ id: 'new-operation' }),
  });

  const result = await apply({ update: {}, idempotencyKey: '123:33' });
  const snapshot = store.snapshot();

  assert.equal(result.duplicate, false);
  assert.deepEqual(snapshot.profile.telegramOperationCheckpoints, [{ botId: '123', updateId: 33 }]);
  assert.deepEqual(snapshot.profile.telegramOperations, [
    { key: '123:31', operationId: 'legacy-1' },
    { key: '123:32', operationId: 'legacy-2' },
  ]);
  assert.deepEqual(
    await apply({ update: {}, idempotencyKey: '123:31' }),
    { operationId: 'legacy-1', duplicate: true },
  );
});

test('keeps legacy ledger entries and advances the replay boundary for new writes', async () => {
  const store = createStore({
    state: { tx: [] },
    telegramOperations: [{ key: '123:41', operationId: 'missing-transaction' }],
  });
  const apply = createProfileFinanceAdapter({
    profileStore: store,
    buildTransaction: async () => transaction({ id: 'new-transaction' }),
  });

  await apply({ update: {}, idempotencyKey: '123:42' });
  const snapshot = store.snapshot();
  assert.deepEqual(snapshot.profile.telegramOperations, [
    { key: '123:41', operationId: 'missing-transaction' },
  ]);
  assert.deepEqual(snapshot.profile.telegramOperationCheckpoints, [{ botId: '123', updateId: 42 }]);
  assert.deepEqual(
    await apply({ update: {}, idempotencyKey: '123:40' }),
    { operationId: 'telegram-replay:123:40', duplicate: true },
  );
});
