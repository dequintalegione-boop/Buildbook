# Durable Telegram inbox

The inbox implementation is `host/inbox-store.mjs`; sender filtering is handled by `host/telegram-update-gate.mjs`. `host/telegram-poller.mjs` receives updates with Telegram long polling, and `host/telegram-offset-store.mjs` persists the polling checkpoint. `host/telegram-inbox-processor.mjs` hands queued updates to the canonical domain adapter.

## Current behavior

- Persists received updates to a local JSON file using write-to-temp then rename.
- The gate checks the numeric sender ID against the configured allowlist before enqueuing. Unauthorized users are not persisted.
- Only private text messages are accepted; the private chat ID must equal the allowlisted sender ID. Group chats, callback queries, inline queries, edited messages, media-only messages and oversized text are rejected.
- The gate persists a minimal envelope containing the update/message IDs, sender/chat IDs, private-chat type and text. It does not copy arbitrary Telegram fields, entities or attachment metadata into the inbox.
- Telegram IDs are checked for safe integer representation before being normalized; text is limited to 4096 characters.
- The poller advances the Telegram offset only after all allowlisted updates in the returned batch have been durably enqueued. If enqueue fails partway through, it leaves the checkpoint unchanged so Telegram can redeliver; inbox idempotency prevents duplicate queue entries.
- The processor validates the queued envelope again before calling the domain adapter: update IDs must match, sender/chat IDs must match the queued user, chat type must be private, and text must be non-empty and at most 4096 characters. A malformed or tampered inbox item is not passed to the domain adapter.
- The processor marks an item complete only after the domain adapter succeeds, and returns failures to `pending`. It passes the stable inbox key as `idempotencyKey`; the adapter must enforce that key atomically with its domain write. The inbox cannot itself guarantee exactly-once financial writes.
- Deduplicates by bot identity and Telegram update ID.
- Tracks pending, processing and completed states, attempts, timestamps, a bounded error message and the committed Buildbook operation ID.
- Recovers interrupted processing to pending after a host restart.
- Exposes counts for the future Telegram status screen.
- Does not itself write financial records. The processor must mark an item complete only after the canonical Buildbook storage adapter commits the operation.

## Important boundaries

- The service must run as a single writer for this JSON store. Multi-process coordination/locking is not implemented.
- The JSON file must live in a user-private application data directory, not in the repository, web root or synchronized cloud folder.
- The temporary-file rename protects against partial file writes, but this is not a transactional database and does not provide multi-file atomic commits.
- This layer alone cannot guarantee capture while the host is offline longer than Telegram's update retention window.
- The file-backed inbox is intentionally separate from the canonical financial data. It may contain pending commands, but completed financial records must be written to the same canonical store used by Buildbook.

## Tests

Run the inbox and Telegram tests with Node.js 22:

```sh
node --test tests/inbox-store.test.mjs tests/telegram-update-gate.test.mjs tests/telegram-poller.test.mjs tests/telegram-inbox-processor.test.mjs
```

The gate tests cover allowlist filtering, private-chat enforcement, payload minimization, media/group rejection and malformed update IDs. Processor tests cover defense-in-depth validation of queued payloads as well as idempotency and retry behavior. Poller tests cover durable checkpoint behavior.

## Runtime coordinator

`host/telegram-runtime.mjs` coordinates one service cycle: recover interrupted inbox entries once, process already-queued entries, poll Telegram, then process newly accepted entries. Draining the inbox before network I/O means a Telegram outage does not block work already received and durably saved. It deliberately does not own timers or process startup; the host lifecycle must schedule cycles, provide cancellation, and enforce a single service process. If polling or domain processing fails, the cycle rejects so the host can apply retry/backoff policy. The runtime does not make the Telegram-to-finance path production-ready until the canonical storage adapter is connected.

Run the complete Node.js unit-test set (including the Telegram gate, poller, processor, runtime, service, config and storage tests) with:

```sh
node --test tests/*.test.mjs
```

The service lifecycle tests also verify that stop cancels an interval wait promptly, the service can restart after stopping, and repeated start calls share one loop. The CI host-test job runs this same command.

## Host configuration

`host/telegram-config.mjs` reads the host-only environment settings and validates them before a service is constructed. Required variables:

- `BUILDBOOK_TELEGRAM_BOT_TOKEN` — bot token; keep it only in the host environment/secret store.
- `BUILDBOOK_TELEGRAM_ALLOWED_USER_IDS` — comma-separated numeric Telegram user IDs.
- `BUILDBOOK_TELEGRAM_INBOX_PATH` and `BUILDBOOK_TELEGRAM_OFFSET_PATH` — distinct absolute paths in the user's private application-data directory.

Optional polling/retry variables are `BUILDBOOK_TELEGRAM_TIMEOUT_SECONDS`, `BUILDBOOK_TELEGRAM_INTERVAL_MS`, `BUILDBOOK_TELEGRAM_RETRY_BASE_MS` and `BUILDBOOK_TELEGRAM_RETRY_MAX_MS`. The config parser rejects invalid ranges and does not log the token. It is configuration validation only; it does not yet start or install a background service.

Run its tests with:

```sh
node --test tests/telegram-config.test.mjs
```
