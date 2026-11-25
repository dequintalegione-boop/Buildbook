import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBuildbookLocalHost } from '../host/buildbook-local-host.mjs';

const token = 'buildbook-setup-api-test-token-0123456789abcdef';

test('the app can save a Telegram bot and the token never comes back', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'buildbook-tg-setup-'));
  const host = createBuildbookLocalHost({
    env: {
      BUILDBOOK_PROFILE_PATH: join(dir, 'profile.json'),
      BUILDBOOK_LOCAL_API_TOKEN: token,
      BUILDBOOK_LOCAL_API_PORT: '0',
      BUILDBOOK_TELEGRAM_ENABLED: 'false',
    },
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, result: [] }) }),
  });
  t.after(() => host.stop());
  t.after(() => rm(dir, { recursive: true, force: true }));
  const address = await host.start();
  const base = 'http://127.0.0.1:' + address.port;
  const bootstrap = await fetch(base + '/api/session/bootstrap', {
    method: 'POST',
    headers: { origin: base, authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: '{}',
  });
  const cookie = bootstrap.headers.get('set-cookie')?.split(';', 1)[0];
  const botToken = '123456789:AA-test-token_value';
  const saved = await fetch(base + '/api/telegram/setup', {
    method: 'PUT',
    headers: { origin: base, cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ botToken, allowedUserIds: ['42', '42'], defaultAccountId: 'a1', start: false }),
  });
  assert.equal(saved.status, 200);
  const view = await saved.json();
  assert.equal(view.configured, true);
  assert.equal(view.botId, '123456789');
  assert.deepEqual(view.allowedUserIds, ['42']);
  assert.equal(view.defaultAccountId, 'a1');
  assert.equal(view.running, false);
  assert.equal(JSON.stringify(view).includes(botToken), false);
  assert.equal(JSON.stringify(view).includes('AA-test'), false);
  const disk = await readFile(join(dir, 'telegram-setup.json'), 'utf8');
  assert.match(disk, /123456789:AA-test-token_value/);
  const again = await fetch(base + '/api/telegram/setup', { headers: { cookie } });
  const listed = await again.json();
  assert.equal(listed.botId, '123456789');
  assert.equal(JSON.stringify(listed).includes('AA-test'), false);
  const appSession = await fetch(base + '/api/session/app', {
    method: 'POST',
    headers: { origin: base, 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(appSession.status, 200);
  const blocked = await fetch(base + '/api/session/app', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(blocked.status, 403);
});
