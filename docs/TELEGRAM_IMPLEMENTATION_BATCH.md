# Telegram integration: implementation batch

This checklist tracks the next implementation batch for `feature/telegram-local-service`. It is not a claim that these items are complete.

## 20 implementation stages

1. Freeze the finance operation contract against the existing `S.tx` schema and required fields.
2. Define the accepted Telegram command grammar and reject unknown or ambiguous commands.
3. Normalize amounts to integer minor units and reject non-finite, negative, or out-of-range values.
4. Validate dates strictly and define the timezone policy.
5. Resolve categories only against the current Buildbook category configuration.
6. Define account selection and reject missing or inactive accounts.
7. Add a canonical operation ID strategy compatible with existing transaction IDs.
8. Store the Telegram idempotency key with the operation in the same canonical commit.
9. Ensure duplicate keys return the previously committed operation ID without adding another transaction.
10. Ensure profile revision conflicts cause a bounded retry, not a second operation.
11. Add the canonical finance adapter behind the existing `applyUpdate` boundary.
12. Keep adapter failures generic in durable inbox state and redact sensitive details from logs.
13. Connect the adapter to the host composition without introducing a second finance ledger.
14. Add a status endpoint that exposes only bounded, sanitized service state.
15. Add local UI client support for status and setup, without embedding the bot token in the app bundle.
16. Define safe first-run token provisioning and protected local secret storage.
17. Add an explicit migration/import path from browser IndexedDB to the shared canonical profile, with backup and conflict handling.
18. Keep browser-only and standalone modes functional when the local host is not configured.
19. Add documented Windows launch/stop and recovery instructions; defer OS autostart until the lifecycle is verified.
20. Perform a code review of the full data path, then run the existing and new tests only after the user authorizes testing.

## Blocking architecture decision

The current browser app stores its profile in IndexedDB, while the Telegram host uses a separate file-backed profile store. The host must not write financial operations to a second ledger. The finance adapter remains blocked until the app and host share one canonical storage boundary or a deliberate, recoverable migration path is implemented.

## Current status

Implemented in code:
- A strict command parser accepts /income, /expense, /доход, and /расход with a positive amount (up to two decimal places) and description.
- The transaction builder maps commands to the existing transaction fields (kind i/e, date, amount, desc, cat, grp, acc, note); it uses existing default categories/groups (income: Заработок / Другое, expense: Общие расходы / Еда), account Наличные, and the host's local calendar date.
- The profile finance adapter validates the transaction and commits it together with the Telegram idempotency key in one profile revision. Replayed keys return the committed operation ID.
- The host can compose this adapter from a profileStore and defaults to the command builder. Invalid/unsupported commands are rejected instead of endlessly retrying and blocking the ordered inbox.
- Added `host/buildbook-local-host.mjs` and `host/run-buildbook-local-host.mjs`: the local API and Telegram processor now share one profile-store instance in the combined host. The composition validates profile/lock/queue path separation and releases locks during shutdown.
- Added authenticated `GET /api/telegram/status`, sanitized to a fixed allowlist of operational fields, plus `client.telegramStatus()`.
- Added focused command/adapter test cases in `tests/telegram-finance-adapter.test.mjs` (not executed).
- The UI-side profile repository adapter preserves host-owned profile metadata during saves and checks the expected revision first, preventing routine UI saves from silently dropping the Telegram idempotency ledger.

Still blocked / incomplete:
- The combined host shares one profile store between API and Telegram, but the UI still starts with browser IndexedDB. The repository adapter is not yet wired into the app startup path; do not treat the UI and host as one live ledger until that switch/migration is implemented and exercised.
- Category/account selection currently uses the app's known defaults; mapping to user-edited categories and accounts remains.
- UI setup, safe token provisioning, browser-to-host migration, and service installation/autostart remain. Status is available from the authenticated local API but not yet displayed in the app.
- Review and tests remain pending; tests have not been run per user instruction.

### Current command format

- /доход 1250.50 Продажа
- /расход 450 Обед

Unknown or malformed commands are terminally rejected so they do not block later inbox items. The host-local calendar date is used for new entries.
