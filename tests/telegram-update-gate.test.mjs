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

test('persists only updates from explicitly allowed Telegram users', async () => {
  const inbox = fakeInbox();
  const gate = createTelegramUpdateGate({ inbox, botId: 'bot-1', allowlist: ['1001'] });
  const denied = await gate.accept({
    update_id: 1,
    message: { from: { id: 2002 }, text: 'secret message' },
  });
  assert.deepEqual(denied, { accepted: false, reason: 'not_allowed' });
  assert.equal(inbox.items.length, 0);

  const accepted = await gate.accept({
    update_id: 2,
    message: { from: { id: 1001 }, text: 'income 500' },
  });
  assert.equal(accepted.accepted, true);
  assert.equal(inbox.items.length, 1);
  assert.equal(inbox.items[0].userId, '1001');
  assert.equal(inbox.items[0].updateId, 2);
});

test('supports callback query senders and numeric-string allowlist IDs', async () => {
  const inbox = fakeInbox();
  const gate = createTelegramUpdateGate({ inbox, botId: 'bot-1', allowlist: [1001] });
  const result = await gate.accept({
    update_id: 4,
    callback_query: { from: { id: 1001 }, data: 'confirm' },
  });
  assert.equal(result.accepted, true);
  assert.equal(inbox.items[0].userId, '1001');
});

test('rejects malformed allowlist and invalid update IDs', async () => {
  const inbox = fakeInbox();
  assert.throws(() => createTelegramUpdateGate({ inbox, botId: 'bot-1', allowlist: ['not-an-id'] }), /invalid user ID/);
  const gate = createTelegramUpdateGate({ inbox, botId: 'bot-1', allowlist: ['1001'] });
  await assert.rejects(gate.accept({ update_id: 'bad', message: { from: { id: 1001 } } }), /update_id/);
  assert.equal(inbox.items.length, 0);
});
