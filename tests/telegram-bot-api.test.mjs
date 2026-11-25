import test from 'node:test';
import assert from 'node:assert/strict';
import { createTelegramBotApi } from '../host/telegram-bot-api.mjs';

const token = '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_123456';
const response = (payload, status = 200) => new Response(JSON.stringify(payload), {
  status,
  headers: { 'content-type': 'application/json' },
});

test('getMe returns only a sanitized bot profile', async () => {
  const api = createTelegramBotApi({
    fetchImpl: async () => response({ ok: true, result: {
      id: 123456789, is_bot: true, first_name: 'Buildbook Helper', username: 'buildbook_helper_bot',
    } }),
  });
  const bot = await api.getMe(token);
  assert.deepEqual(bot, {
    id: '123456789', firstName: 'Buildbook Helper', username: 'buildbook_helper_bot',
    canJoinGroups: false, canReadAllGroupMessages: false, supportsInlineQueries: false,
  });
  assert.equal(JSON.stringify(bot).includes(token), false);
});

test('invalid token errors never include the credential or request URL', async () => {
  const api = createTelegramBotApi({
    fetchImpl: async () => response({ ok: false, error_code: 401, description: 'Unauthorized' }, 401),
  });
  await assert.rejects(api.getMe(token), error => {
    assert.equal(error.code, 'TELEGRAM_TOKEN_REJECTED');
    assert.equal(error.message.includes(token), false);
    return true;
  });
});

test('setMyCommands normalizes valid entries and rejects invalid or duplicate commands', async () => {
  let body;
  const api = createTelegramBotApi({
    fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body);
      return response({ ok: true, result: true });
    },
  });
  await api.setMyCommands(token, [
    { command: '/income', description: 'Добавить доход' },
    { command: 'expense', description: 'Добавить расход' },
  ]);
  assert.deepEqual(body.commands, [
    { command: 'income', description: 'Добавить доход' },
    { command: 'expense', description: 'Добавить расход' },
  ]);
  await assert.rejects(api.setMyCommands(token, [
    { command: 'income', description: 'Первый' },
    { command: 'income', description: 'Повтор' },
  ]), /не должны повторяться/);
});
