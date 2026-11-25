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
    const baseUrl = `http://127.0.0.1:${address.port}`;
    // Node's fetch has no browser cookie jar. Model the browser's Origin and
    // HttpOnly session-cookie handling for this integration test.
    let sessionCookie = '';
    const fetchImpl = async (url, options = {}) => {
      const headers = new Headers(options.headers || {});
      headers.set('origin', new URL(url).origin);
      if (sessionCookie) headers.set('cookie', sessionCookie);
      const response = await fetch(url, { ...options, headers });
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) sessionCookie = setCookie.split(';', 1)[0];
      return response;
    };
    const client = createLocalProfileClient({
      baseUrl,
      accessToken: TOKEN,
      fetchImpl,
    });
    await client.connectSession();
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
      update: { update_id: 88, message: { text: '/доход 250 Оплата через Telegram' } },
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
    assert.deepEqual(canonical.profile.telegramOperationCheckpoints, [
      { botId: '12345', updateId: 88 },
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


test('repository adapter rejects malformed canonical profile responses and revisions', async () => {
  const invalidRead = createProfileRepositoryAdapter({
    readProfile: async () => ({ revision: -1, profile: null }),
    writeProfile: async () => 1,
  });
  await assert.rejects(invalidRead.readProfile(), /некорректный ответ/);

  const invalidWriteResult = createProfileRepositoryAdapter({
    readProfile: async () => ({ revision: 0, profile: null }),
    writeProfile: async () => 4,
  });
  await assert.rejects(
    invalidWriteResult.writeProfile({}, [], {}, 0),
    /некорректную ревизию после сохранения/,
  );

  const malformedCurrent = createProfileRepositoryAdapter({
    readProfile: async () => ({ revision: 0, profile: [] }),
    writeProfile: async () => 1,
  });
  await assert.rejects(malformedCurrent.writeProfile({}, [], {}, 0), /некорректный ответ/);
});
