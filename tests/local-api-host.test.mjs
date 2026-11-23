import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { createLocalApiHost } from '../host/local-api-host.mjs';

const token = 'local-api-host-test-token-0123456789abcdef';

async function fixture(t, extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'buildbook-host-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const host = createLocalApiHost({
    env: {
      BUILDBOOK_PROFILE_PATH: join(dir, 'profile.json'),
      BUILDBOOK_LOCAL_API_TOKEN: token,
      BUILDBOOK_LOCAL_API_PORT: '0',
      ...extra,
    },
  });
  t.after(() => host.stop());
  return host;
}

test('releases the profile lock when API bind fails and permits retry', async (t) => {
  const blocker = createServer();
  await new Promise((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(0, '127.0.0.1', resolve);
  });
  const port = blocker.address().port;
  const dir = await mkdtemp(join(tmpdir(), 'buildbook-host-bind-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const host = createLocalApiHost({
    env: {
      BUILDBOOK_PROFILE_PATH: join(dir, 'profile.json'),
      BUILDBOOK_LOCAL_API_TOKEN: token,
      BUILDBOOK_LOCAL_API_PORT: String(port),
    },
  });
  t.after(() => host.stop());
  await assert.rejects(host.start(), error => error.code === 'EADDRINUSE');
  await new Promise(resolve => blocker.close(resolve));
  const address = await host.start();
  assert.equal(address.port, port);
});

test('exclusive profile lock prevents a second API host from sharing the canonical file', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'buildbook-host-lock-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = {
    BUILDBOOK_PROFILE_PATH: join(dir, 'profile.json'),
    BUILDBOOK_LOCAL_API_TOKEN: token,
    BUILDBOOK_LOCAL_API_PORT: '0',
  };
  const first = createLocalApiHost({ env });
  const second = createLocalApiHost({ env });
  t.after(() => first.stop());
  t.after(() => second.stop());
  await first.start();
  await assert.rejects(second.start(), error => error.code === 'BUILDBOOK_INSTANCE_LOCKED');
  await first.stop();
  const address = await second.start();
  assert.ok(address.port > 0);
});

test('starts a loopback API and serves the configured profile store', async (t) => {
  const host = await fixture(t);
  const address = await host.start();
  assert.equal(host.running, true);
  const response = await fetch(`http://127.0.0.1:${address.port}/api/profile`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { revision: 0, profile: null });
  await host.stop();
  assert.equal(host.running, false);
});

test('rejects a profile lock path that aliases the profile file', () => {
  assert.throws(() => createLocalApiHost({
    env: {
      BUILDBOOK_PROFILE_PATH: '/tmp/profile.json',
      BUILDBOOK_PROFILE_LOCK_PATH: '/tmp/profile.json',
      BUILDBOOK_LOCAL_API_TOKEN: token,
    },
  }), /distinct from the canonical profile path/);
});

test('validates required host configuration and port range', () => {
  assert.throws(() => createLocalApiHost({ env: {} }), /BUILDBOOK_PROFILE_PATH is required/);
  assert.throws(() => createLocalApiHost({
    env: {
      BUILDBOOK_PROFILE_PATH: '/tmp/profile.json',
      BUILDBOOK_LOCAL_API_TOKEN: token,
      BUILDBOOK_LOCAL_API_PORT: '70000',
    },
  }), /between 0 and 65535/);
});

test('supports repeated start and stop calls without opening extra listeners', async (t) => {
  const host = await fixture(t);
  const [first, second] = await Promise.all([host.start(), host.start()]);
  assert.equal(first.port, second.port);
  assert.equal(host.running, true);
  await Promise.all([host.stop(), host.stop()]);
  assert.equal(host.running, false);
});

test('can restart the host after a completed stop', async (t) => {
  const host = await fixture(t);
  await host.start();
  await host.stop();
  const second = await host.start();
  assert.ok(second.port > 0);
  assert.equal(host.running, true);
  await host.stop();
});

test('serializes a stop requested during startup and allows a clean restart', async (t) => {
  const host = await fixture(t);
  const starting = host.start();
  const stopping = host.stop();

  await Promise.all([starting, stopping]);
  assert.equal(host.running, false);

  const restarted = await host.start();
  assert.ok(restarted.port > 0);
  assert.equal(host.running, true);
  await host.stop();
  assert.equal(host.running, false);
});
