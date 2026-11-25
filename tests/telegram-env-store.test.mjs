import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, lstat, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateTelegramEnvFile } from '../host/telegram-env-store.mjs';

async function withDirectory(run) {
  const dir = await mkdtemp(join(tmpdir(), 'buildbook-telegram-env-'));
  try { await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('updates only allowlisted Telegram keys atomically and keeps a protected backup', async () => {
  await withDirectory(async dir => {
    const envFile = join(dir, '.env');
    await writeFile(envFile, [
      '# Keep this comment',
      'BUILDBOOK_LOCAL_API_TOKEN=local-secret',
      'BUILDBOOK_TELEGRAM_BOT_TOKEN=old-token',
      'BUILDBOOK_TELEGRAM_BOT_TOKEN=duplicate-old-token',
      'BUILDBOOK_TELEGRAM_ALLOWED_USER_IDS=1001',
      '',
    ].join('\n'), { mode: 0o600 });
    const result = await updateTelegramEnvFile({
      envFile,
      values: {
        BUILDBOOK_TELEGRAM_BOT_TOKEN: '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_123456',
        BUILDBOOK_TELEGRAM_ALLOWED_USER_IDS: '2002',
        BUILDBOOK_TELEGRAM_ENABLED: 'true',
      },
    });
    const text = await readFile(envFile, 'utf8');
    assert.equal(result.backedUp, true);
    assert.match(text, /BUILDBOOK_LOCAL_API_TOKEN=local-secret/);
    assert.match(text, /BUILDBOOK_TELEGRAM_ALLOWED_USER_IDS=2002/);
    assert.match(text, /BUILDBOOK_TELEGRAM_ENABLED=true/);
    assert.equal((text.match(/BUILDBOOK_TELEGRAM_BOT_TOKEN=/g) || []).length, 1);
    const backup = (await readdir(dir)).find(name => name.startsWith('.env.backup-'));
    assert.ok(backup);
    assert.match(await readFile(join(dir, backup), 'utf8'), /old-token/);
    assert.equal((await lstat(envFile)).mode & 0o777, 0o600);
  });
});

test('rejects unapproved environment keys and symbolic-link .env paths', async () => {
  await withDirectory(async dir => {
    const envFile = join(dir, '.env');
    await writeFile(envFile, 'SAFE=true\n');
    await assert.rejects(updateTelegramEnvFile({
      envFile,
      values: { PATH: 'C:\\unsafe' },
    }), /allowlisted/);
    const link = join(dir, 'linked.env');
    await symlink(envFile, link);
    await assert.rejects(updateTelegramEnvFile({
      envFile: link,
      values: { BUILDBOOK_TELEGRAM_ENABLED: 'false' },
    }), /обычным файлом/);
  });
});
