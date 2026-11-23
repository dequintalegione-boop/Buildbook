# Durable Telegram inbox

The inbox implementation is `host/inbox-store.mjs`; sender filtering is handled by `host/telegram-update-gate.mjs`. These are host-side modules, not a financial ledger. `host/telegram-poller.mjs` receives updates with Telegram long polling, and `host/telegram-offset-store.mjs` persists the polling checkpoint.

## Current behavior

- Persists received updates to a local JSON file using write-to-temp then rename.
- `createTelegramUpdateGate` validates numeric allowlist IDs and checks the sender before enqueuing; rejected updates are not persisted.\n- The poller advances the Telegram offset only after all allowlisted updates in the returned batch have been durably enqueued. If enqueue fails partway through, it leaves the checkpoint unchanged so Telegram can redeliver; inbox idempotency prevents duplicate queue entries.\n- Deduplicates by bot identity and Telegram update ID.
- Tracks pending, processing and completed states, attempts, timestamps, a bounded error message and the committed Buildbook operation ID.
- Recovers interrupted processing to pending after a host restart.
- Exposes counts for the future Telegram status screen.
- Does not itself acknowledge Telegram polling offsets or write financial records. The future receiver must enqueue durably before advancing its offset, and the processor must mark an item complete only after the canonical Buildbook storage adapter commits the operation.

## Important boundaries

- The service must run as a single writer for this JSON store. Multi-process coordination/locking is not implemented.
- The JSON file must live in a user-private application data directory, not in the repository, web root or synchronized cloud folder.
- The temporary-file rename protects against partial file writes, but this is not a transactional database and does not provide multi-file atomic commits.
- This layer alone cannot guarantee capture while the host is offline longer than Telegram's update retention window.
- The file-backed inbox is intentionally separate from the canonical financial data. It may contain pending commands, but completed financial records must be written to the same canonical store used by Buildbook.

## Tests

Run with Node.js 22:

```sh
node --test tests/inbox-store.test.mjs
```

The inbox test suite covers duplicate delivery, persistence across store instances, retry after failure, recovery after interruption, completed-item exclusion and numeric ID validation. The Telegram gate and poller suites cover allowlist filtering and durable checkpoint behavior.
