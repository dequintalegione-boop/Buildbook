import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTelegramFinanceCommand,
  buildTelegramFinanceTransactionFromUpdate,
} from '../host/telegram-finance-command.mjs';
import { createProfileFinanceAdapter } from '../host/profile-finance-adapter.mjs';

function makeStore(profile) {
  let revision = 4;
  let current = structuredClone(profile);
  return {
    async read() { return { revision, profile: structuredClone(current) }; },
    async write(next, expectedRevision) {
      if (expectedRevision !== revision) {
        const error = new Error('revision conflict');
        error.code = 'BUILD_BOOK_STORAGE_CONFLICT';
        throw error;
      }
      current = structuredClone(next);
      revision += 1;
      return revision;
    },
    snapshot() { return { revision, profile: structuredClone(current) }; },
  };
}

test('parser accepts supported income and expense commands', () => {
  assert.deepEqual(parseTelegramFinanceCommand('/доход 1250,50 Сборка ПК'), {
    kind: 'i', amount: 1250.5, desc: 'Сборка ПК',
  });
  assert.deepEqual(parseTelegramFinanceCommand('/expense 450 Lunch'), {
    kind: 'e', amount: 450, desc: 'Lunch',
  });
  assert.equal(parseTelegramFinanceCommand('обычный текст'), null);
});

test('parser rejects malformed amounts and empty descriptions', () => {
  assert.throws(() => parseTelegramFinanceCommand('/доход -10 тест'));
  assert.throws(() => parseTelegramFinanceCommand('/расход 10'));
  assert.throws(() => parseTelegramFinanceCommand('/income 1.999 bad'));
});

test('transaction builder uses Buildbook transaction fields and host-local date', () => {
  const transaction = buildTelegramFinanceTransactionFromUpdate({
    message: { text: '/расход 99,90 Обед' },
  }, { now: new Date(2026, 10, 23, 12, 0, 0) });
  assert.deepEqual(transaction, {
    kind: 'e',
    date: '2026-11-23',
    amount: 99.9,
    desc: 'Обед',
    cat: 'Еда',
    grp: 'Общие расходы',
    acc: 'a1',
    note: 'Добавлено через Telegram',
  });
});


test('transaction builder resolves visible categories and account IDs from profile', () => {
  const transaction = buildTelegramFinanceTransactionFromUpdate({
    message: { text: '/income 25 Заказ' },
  }, {
    now: new Date(2026, 10, 23),
    profile: {
      state: {
        categories: { i: { 'Другой доход': ['Услуги', 'Продажа'] } },
        hiddenGroups: { i: [] },
        hiddenCategories: { i: [] },
        accounts: [{ id: 'cash-main', name: 'Наличные', open: 0 }],
      },
    },
  });
  assert.equal(transaction.grp, 'Другой доход');
  assert.equal(transaction.cat, 'Услуги');
  assert.equal(transaction.acc, 'cash-main');
});

test('profile adapter commits a transaction and its idempotency key together', async () => {
  const store = makeStore({ state: { tx: [] }, logs: [], photos: [] });
  const applyUpdate = createProfileFinanceAdapter({
    profileStore: store,
    buildTransaction: () => ({
      kind: 'i', date: '2026-11-23', amount: 100, desc: 'Проверка',
      cat: 'Другое', grp: 'Заработок', acc: 'a1',
    }),
  });
  const first = await applyUpdate({ update: {}, idempotencyKey: '12345:7' });
  const duplicate = await applyUpdate({ update: {}, idempotencyKey: '12345:7' });
  const snapshot = store.snapshot();
  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.operationId, first.operationId);
  assert.equal(snapshot.profile.state.tx.length, 1);
  assert.equal(snapshot.profile.telegramOperations.length, 1);
});

test('profile adapter refuses stale revision without writing', async () => {
  const store = makeStore({ state: { tx: [] } });
  const applyUpdate = createProfileFinanceAdapter({
    profileStore: {
      async read() { return { revision: 2, profile: { state: { tx: [] } } }; },
      async write() {
        const error = new Error('conflict');
        error.code = 'BUILD_BOOK_STORAGE_CONFLICT';
        throw error;
      },
    },
    buildTransaction: () => ({
      kind: 'e', date: '2026-11-23', amount: 1, desc: 'Тест',
      cat: 'Еда', grp: 'Общие расходы', acc: 'a1',
    }),
  });
  await assert.rejects(() => applyUpdate({ update: {}, idempotencyKey: '12345:8' }), {
    code: 'BUILD_BOOK_STORAGE_CONFLICT',
  });
  assert.equal(store.snapshot().profile.state.tx.length, 0);
});
