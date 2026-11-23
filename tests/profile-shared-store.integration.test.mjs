import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProfileStore } from '../host/profile-store.mjs';
import { createLocalApiServer } from '../host/local-api.mjs';
import { createLocalProfileClient } from '../host/local-profile-client.mjs';
import { createProfileRepositoryAdapter } from '../host/profile-repository-adapter.mjs';
import { createProfileFinanceAdapter } from '../host/profile-finance-adapter.mjs';

const TOKEN = 'integration-test-token-that-is-long-enough-123456';

test('browser repository and Telegram finance adapter share one canonical profile', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'buildbook-profile-integration-'));
  const store = createProfileStore(join(directory, 'profile.json'));
  const server = createLocalApiServer({ profileStore: store, accessToken: TOKEN });
  let address;

  try {
    await store.write({ state: { tx: [] }, logs: [], photos: {} }, 0);
    address = await server.listen();
    const client = createLocalProfileClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      accessToken: TOKEN,
    });
    const repository = createProfileRepositoryAdapter(client);
    const financeAdapter = createProfileFinanceAdapter({
      profileStore: store,
      buildTransaction: async () => ({
        kind: 'i',
        date: '2026-11-23',
        amount: 250,
        desc: 'Оплата через Telegram',
        cat: 'Услуги',
        grp: 'Доходы',
        acc: 'a1',
      }),
    });

    const appProfile = await repository.readProfile();
    appProfile.state.tx.push({
      id: 'ui-transaction',
      kind: 'e',
      date: '2026-11-23',
      amount: 40,
      desc: 'Запись из интерфейса',
      cat: 'Еда',
      grp: 'Расходы',
      acc: 'a1',
    });
    const appRevision = await repository.writeProfile(
      appProfile.state,
      appProfile.logs || [],
      appProfile.photos || {},
      appProfile.revision,
    );

    const telegramResult = await financeAdapter({
      update: { message: { text: '/доход 250 Оплата через Telegram' } },
      idempotencyKey: '12345:88',
    });

    const canonical = await client.readProfile();
    assert.equal(appRevision, 2);
    assert.equal(telegramResult.revision, 3);
    assert.equal(canonical.revision, 3);
    assert.deepEqual(
      canonical.profile.state.tx.map(item => item.id),
      ['ui-transaction', telegramResult.operationId],
    );
    assert.deepEqual(canonical.profile.telegramOperations, [
      { key: '12345:88', operationId: telegramResult.operationId },
    ]);

    // A tab holding revision 2 must not overwrite the Telegram commit at revision 3.
    await assert.rejects(
      repository.writeProfile(
        { tx: [{ id: 'stale-ui-overwrite' }] },
        [],
        {},
        appRevision,
      ),
      error => error?.code === 'BUILD_BOOK_STORAGE_CONFLICT'
        && error.expectedRevision === appRevision
        && error.currentRevision === telegramResult.revision,
    );
    const afterStaleSave = await client.readProfile();
    assert.equal(afterStaleSave.revision, 3);
    assert.deepEqual(
      afterStaleSave.profile.state.tx.map(item => item.id),
      ['ui-transaction', telegramResult.operationId],
    );
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
