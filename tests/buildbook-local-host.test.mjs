import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBuildbookLocalHost } from '../host/buildbook-local-host.mjs';

const token = 'buildbook-combined-host-test-token-0123456789abcdef';

test('combined local host keeps Telegram disabled until the shared UI profile is ready', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'buildbook-combined-host-'));
  const host = createBuildbookLocalHost({ env: { BUILDBOOK_PROFILE_PATH: join(dir, 'profile.json'), BUILDBOOK_LOCAL_API_TOKEN: token, BUILDBOOK_LOCAL_API_PORT: '0' } });
  t.after(() => host.stop());
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.deepEqual(host.telegramStatus, { enabled: false, running: false });
  const address = await host.start();
  const base = 'http://127.0.0.1:' + address.port;
  const app = await fetch(base + '/');
  assert.equal(app.status, 200);
  assert.match(await app.text(), /Buildbook/);
  const bootstrap = await fetch(base + '/api/session/bootstrap', {
    method: 'POST',
    headers: { origin: base, authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(bootstrap.status, 200);
  const sessionCookie = bootstrap.headers.get('set-cookie')?.split(';', 1)[0];
  assert.ok(sessionCookie, 'bootstrap should issue a browser-managed session cookie');
  const response = await fetch(base + '/api/telegram/status', { headers: { cookie: sessionCookie } });
  assert.equal(response.status, 200);
  const status = await response.json();
  assert.equal(status.enabled, false);
  assert.equal(status.running, false);
});

test('combined local host rejects an ambiguous Telegram enable flag', () => {
  assert.throws(() => createBuildbookLocalHost({ env: { BUILDBOOK_PROFILE_PATH: '/tmp/buildbook-profile.json', BUILDBOOK_LOCAL_API_TOKEN: token, BUILDBOOK_TELEGRAM_ENABLED: 'sometimes' } }), /BUILDBOOK_TELEGRAM_ENABLED must be true or false/);
});


test('combined local host starts with example Telegram placeholders so setup can happen in the app', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'buildbook-placeholder-telegram-'));
  const host = createBuildbookLocalHost({ env: {
    BUILDBOOK_PROFILE_PATH: join(dir, 'profile.json'),
    BUILDBOOK_LOCAL_API_TOKEN: token,
    BUILDBOOK_LOCAL_API_PORT: '0',
    BUILDBOOK_TELEGRAM_ENABLED: 'false',
    BUILDBOOK_TELEGRAM_BOT_TOKEN: 'REPLACE_WITH_BOTFATHER_TOKEN',
    BUILDBOOK_TELEGRAM_ALLOWED_USER_IDS: 'REPLACE_WITH_NUMERIC_TELEGRAM_USER_ID',
  } });
  t.after(() => host.stop());
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.deepEqual(host.telegramStatus, { enabled: false, running: false });
  const address = await host.start();
  assert.ok(address.port > 0);
});

test('combined local host refuses to start Telegram with example placeholder credentials', () => {
  assert.throws(() => createBuildbookLocalHost({ env: {
    BUILDBOOK_PROFILE_PATH: '/tmp/buildbook-placeholder-profile.json',
    BUILDBOOK_LOCAL_API_TOKEN: token,
    BUILDBOOK_TELEGRAM_ENABLED: 'true',
    BUILDBOOK_TELEGRAM_BOT_TOKEN: 'REPLACE_WITH_BOTFATHER_TOKEN',
    BUILDBOOK_TELEGRAM_ALLOWED_USER_IDS: 'REPLACE_WITH_NUMERIC_TELEGRAM_USER_ID',
  } }), /Telegram включён, но токен бота или белый список не настроены/);
});


test('combined local host exposes the trusted main update status through its browser session', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'buildbook-update-integration-'));
  const latestCommit = 'c'.repeat(40);
  const host = createBuildbookLocalHost({
    env: {
      BUILDBOOK_PROFILE_PATH: join(dir, 'profile.json'),
      BUILDBOOK_LOCAL_API_TOKEN: token,
      BUILDBOOK_LOCAL_API_PORT: '0',
    },
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.github.com/repos/dequintalegione-boop/Buildbook/commits/main');
      assert.equal(options.redirect, 'error');
      return {
        ok: true,
        json: async () => ({
          sha: latestCommit,
          commit: { message: 'Test update', committer: { date: '2026-11-27T10:00:00Z' } },
        }),
      };
    },
  });
  t.after(() => host.stop());
  t.after(() => rm(dir, { recursive: true, force: true }));
  const address = await host.start();
  const base = 'http://127.0.0.1:' + address.port;
  const bootstrap = await fetch(base + '/api/session/bootstrap-local', {
    method: 'POST',
    headers: { origin: base, 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(bootstrap.status, 200);
  const cookie = bootstrap.headers.get('set-cookie')?.split(';', 1)[0];
  const response = await fetch(base + '/api/updates/status', { headers: { cookie } });
  assert.equal(response.status, 200);
  const status = await response.json();
  assert.equal(status.repository, 'dequintalegione-boop/Buildbook');
  assert.equal(status.branch, 'main');
  assert.equal(status.latestCommit, latestCommit);
  assert.equal(status.installationTracked, false);
  assert.equal(status.updateAvailable, null);
});
