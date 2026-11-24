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
  const response = await fetch(base + '/api/telegram/status', { headers: { authorization: 'Bearer ' + token } });
  assert.equal(response.status, 200);
  const status = await response.json();
  assert.equal(status.enabled, false);
  assert.equal(status.running, false);
});

test('combined local host rejects an ambiguous Telegram enable flag', () => {
  assert.throws(() => createBuildbookLocalHost({ env: { BUILDBOOK_PROFILE_PATH: '/tmp/buildbook-profile.json', BUILDBOOK_LOCAL_API_TOKEN: token, BUILDBOOK_TELEGRAM_ENABLED: 'sometimes' } }), /BUILDBOOK_TELEGRAM_ENABLED must be true or false/);
});
