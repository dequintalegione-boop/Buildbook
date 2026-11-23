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

test('commits transaction and idempotency key in one canonical revision', async () => {
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
  assert.deepEqual(snapshot.profile.telegramOperations, [{ key: '123:7', operationId: 'tx-1' }]);
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
