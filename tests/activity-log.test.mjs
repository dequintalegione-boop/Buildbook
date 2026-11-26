import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createActivityLog } from '../host/activity-log.mjs';

test('activity log persists safe operational events and returns newest first', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'buildbook-activity-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'activity.json');
  const first = createActivityLog({ path, now: () => new Date('2026-11-26T10:00:00.000Z') });
  await first.record({ action: 'telegram_setup', status: 'success', message: 'Бот настроен.' });
  await first.record({ action: 'allowlist_update', status: 'success', message: 'Белый список обновлён.' });
  const second = createActivityLog({ path });
  const events = await second.recent(10);
  assert.equal(events.length, 2);
  assert.equal(events[0].action, 'allowlist_update');
  assert.equal(events[1].action, 'telegram_setup');
  assert.equal(JSON.parse(await readFile(path, 'utf8')).version, 1);
});

test('activity log keeps the complete history by default', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'buildbook-activity-unlimited-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'activity.json');
  const log = createActivityLog({ path });
  await Promise.all(Array.from({ length: 520 }, (_, index) => log.record({
    action: 'telegram_event',
    status: 'success',
    message: 'Событие ' + index,
  })));
  const stored = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(stored.events.length, 520);
  const reopened = createActivityLog({ path });
  const latest = await reopened.recent(500);
  assert.equal(latest.length, 500);
  assert.equal(latest[0].message, 'Событие 519');
  assert.equal(latest[499].message, 'Событие 20');
});

test('activity log serializes concurrent writes and applies bounded retention', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'buildbook-activity-limit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = createActivityLog({ path: join(dir, 'activity.json'), limit: 5 });
  await Promise.all(Array.from({ length: 20 }, (_, index) => log.record({
    action: 'local_helper',
    status: index === 7 ? 'error' : 'success',
    message: 'Действие ' + index,
  })));
  const events = await log.recent(10);
  assert.equal(events.length, 5);
  assert.equal(events[0].message, 'Действие 19');
  assert.equal(events[4].message, 'Действие 15');
});

test('activity log rejects credentials, multiline messages and invalid action names', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'buildbook-activity-invalid-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = createActivityLog({ path: join(dir, 'activity.json') });
  await assert.rejects(log.record({ action: 'telegram setup', status: 'success', message: 'ok' }), /invalid fields/i);
  await assert.rejects(log.record({ action: 'telegram_setup', status: 'success', message: 'token\nsecret' }), /invalid fields/i);
  await assert.rejects(log.record({ action: 'telegram_setup', status: 'error', message: 'x'.repeat(201) }), /invalid fields/i);
});


test('corrupt optional activity journal does not prevent new events from being recorded', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'buildbook-activity-corrupt-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'activity.json');
  await (await import('node:fs/promises')).writeFile(path, '{broken');
  const log = createActivityLog({ path });
  await log.record({ action: 'telegram_start', status: 'success', message: 'Telegram запущен.' });
  assert.equal((await log.recent(10)).length, 1);
});

test('activity journal supports offset pagination without losing chronological ordering', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'buildbook-activity-pages-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = createActivityLog({ path: join(dir, 'activity.json') });
  for (let index = 0; index < 7; index += 1) {
    await log.record({ action: 'page_test', status: 'success', message: 'Event ' + index });
  }
  const first = await log.recent(3, 0);
  const second = await log.recent(3, 3);
  const third = await log.recent(3, 6);
  assert.deepEqual(first.map(event => event.message), ['Event 6', 'Event 5', 'Event 4']);
  assert.deepEqual(second.map(event => event.message), ['Event 3', 'Event 2', 'Event 1']);
  assert.deepEqual(third.map(event => event.message), ['Event 0']);
});

test('activity journal stores safe Telegram identifiers without storing message text', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'buildbook-activity-telegram-meta-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = createActivityLog({ path: join(dir, 'activity.json') });
  const event = await log.record({
    action: 'telegram_operation_committed',
    status: 'success',
    message: 'Финансовая операция успешно сохранена в Buildbook.',
    telegramUserId: '123456789',
    updateId: 77,
    operationId: 'transaction-77',
  });
  assert.equal(event.telegramUserId, '123456789');
  assert.equal(event.updateId, 77);
  assert.equal(event.operationId, 'transaction-77');
  await assert.rejects(log.record({
    action: 'telegram_message_accepted',
    status: 'success',
    message: 'Принято',
    telegramUserId: 'not-an-id',
  }), /invalid fields/i);
});
