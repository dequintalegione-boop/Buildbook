import test from 'node:test';
import assert from 'node:assert/strict';
import { createTelegramUpdateGate } from '../host/telegram-update-gate.mjs';

function fakeInbox() {
  const items = [];
  return {
    items,
    async enqueue(item) {
      items.push(item);
      return { inserted: true, item };
    },
  };
}

function privateMessage({ updateId = 1, userId = 1001, chatId = userId, text = 'income 500', extra = {} } = {}) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: userId },
      chat: { id: chatId, type: 'private' },
      text,
      ...extra,
    },
  };
}

test('persists only private text messages from explicitly allowed Telegram users', async () => {
  const inbox = fakeInbox();
  const gate = createTelegramUpdateGate({ inbox, botId: 'bot-1', allowlist: ['1001'] });

  const denied = await gate.accept(privateMessage({ userId: 2002, text: 'secret message' }));
  assert.deepEqual(denied, { accepted: false, reason: 'not_allowed' });
  assert.equal(inbox.items.length, 0);

  const accepted = await gate.accept(privateMessage({ updateId: 2 }));
  assert.equal(accepted.accepted, true);
  assert.equal(inbox.items.length, 1);
  assert.equal(inbox.items[0].userId, '1001');
  assert.equal(inbox.items[0].updateId, 2);
  assert.deepEqual(inbox.items[0].update, {
    update_id: 2,
    message: {
      message_id: 2,
      from: { id: 1001 },
      chat: { id: 1001, type: 'private' },
      text: 'income 500',
    },
  });
});

test('rejects group chats, mismatched chat IDs, non-text updates and oversized text', async () => {
  const inbox = fakeInbox();
  const gate = createTelegramUpdateGate({ inbox, botId: 'bot-1', allowlist: ['1001'] });

  const group = privateMessage({ extra: { chat: { id: -100, type: 'group' } } });
  const mismatched = privateMessage({ chatId: 9999 });
  const mediaOnly = privateMessage({ text: undefined, extra: { photo: [{ file_id: 'sensitive-file' }] } });
  const oversized = privateMessage({ text: 'x'.repeat(4097) });

  for (const update of [group, mismatched, mediaOnly, oversized]) {
    assert.deepEqual(await gate.accept(update), { accepted: false, reason: 'unsupported_update' });
  }
  assert.equal(inbox.items.length, 0);
});

test('does not accept callback queries or inline queries as financial commands', async () => {
  const inbox = fakeInbox();
  const gate = createTelegramUpdateGate({ inbox, botId: 'bot-1', allowlist: ['1001'] });
  assert.deepEqual(await gate.accept({
    update_id: 4,
    callback_query: { from: { id: 1001 }, data: 'confirm' },
  }), { accepted: false, reason: 'not_allowed' });
  assert.deepEqual(await gate.accept({
    update_id: 5,
    inline_query: { from: { id: 1001 }, query: 'income 500' },
  }), { accepted: false, reason: 'not_allowed' });
  assert.equal(inbox.items.length, 0);
});

test('rejects malformed allowlist and invalid update IDs', async () => {
  const inbox = fakeInbox();
  assert.throws(() => createTelegramUpdateGate({ inbox, botId: 'bot-1', allowlist: ['not-an-id'] }), /invalid user ID/);
  const gate = createTelegramUpdateGate({ inbox, botId: 'bot-1', allowlist: ['1001'] });
  await assert.rejects(gate.accept(privateMessage({ updateId: 'bad' })), /update_id/);
  assert.equal(inbox.items.length, 0);
});
