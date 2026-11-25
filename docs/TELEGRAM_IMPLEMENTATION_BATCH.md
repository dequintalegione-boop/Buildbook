# Telegram integration: implementation batch

This checklist tracks the Telegram integration work on `feature/telegram-setup-wizard` and its follow-up tasks. It is not a claim that every item below is complete.

## 20 implementation stages

1. Freeze the finance operation contract against the existing `S.tx` schema and required fields.
2. Define the accepted Telegram command grammar and reject unknown or ambiguous commands.
3. Normalize amounts to integer minor units and reject non-finite, negative, or out-of-range values.
4. Validate dates strictly and define the timezone policy.
5. Resolve categories only against the current Buildbook category configuration.
6. Define account selection and reject missing or inactive accounts.
7. Add a canonical operation ID strategy compatible with existing transaction IDs.
8. Store a per-bot monotonic replay checkpoint with each finance operation in the same canonical commit; retain exact-key legacy ledger compatibility.
9. Ensure duplicate/replayed update IDs at or below the checkpoint cannot add another transaction; process accepted updates serially in increasing update-ID order.
10. Ensure profile revision conflicts cause a bounded retry, not a second operation.
11. Add the canonical finance adapter behind the existing `applyUpdate` boundary.
12. Keep adapter failures generic in durable inbox state and redact sensitive details from logs.
13. Connect the adapter to the host composition without introducing a second finance ledger.
14. Add a status endpoint that exposes only bounded, sanitized service state.
15. Add local UI client support for status and setup, without embedding the bot token in the app bundle. **Implemented:** the client supports authenticated status reads and the Telegram tab displays connection, queue, and sanitized service state.
16. Define safe first-run token provisioning and protected local secret storage.
17. Add an explicit migration/import path from browser IndexedDB to the shared canonical profile, with backup and conflict handling. Design contract: [TELEGRAM_PROFILE_MIGRATION.md](./TELEGRAM_PROFILE_MIGRATION.md). **Implemented in the browser UI:** transfer-envelope validation, backup warning, empty-target check, preview/confirmation, authenticated import, read-back checksum verification, and explicit storage-mode switch. Remaining work is to exercise the full migration and recovery path.
18. Keep browser-only and standalone modes functional when the local host is not configured.
19. Add documented Windows launch/stop and recovery instructions; defer OS autostart until the lifecycle is verified.
20. Perform a code review of the full data path, then run the existing and new tests only after the user authorizes testing.

## Blocking architecture decision

The current browser app stores its profile in IndexedDB, while the Telegram host uses a separate file-backed profile store. The host must not write financial operations to a second ledger. The canonical finance adapter is implemented against the host profile store. The remaining release gate is to run and review the full migration/recovery path on a real local host and verify the browser and Telegram writer observe the same profile revision. Do not enable live financial writes until that end-to-end check passes.

## Current status

Implemented in code:
- A strict command parser accepts /income, /expense, /доход, and /расход with a positive amount (up to two decimal places) and description.
- The transaction builder maps commands to the existing transaction fields (kind i/e, date, amount, desc, cat, grp, acc, note); it resolves the currently visible category and group from the canonical profile (preferring income group Заработок/category Другое and expense group Общие расходы/category Еда), stores the selected account ID (preferring Наличные), and uses the host's local calendar date.
- The profile finance adapter validates the transaction and commits it together with a per-bot replay checkpoint in one profile revision. Exact legacy keys return their recorded operation ID; replays at or below the checkpoint return a completion marker without another transaction. Revision conflicts are retried up to three times, rechecking the checkpoint after each read.
- The host can compose this adapter from a profileStore and defaults to the command builder. Invalid/unsupported commands are rejected instead of endlessly retrying and blocking the ordered inbox.
- Added `host/buildbook-local-host.mjs` and `host/run-buildbook-local-host.mjs`: the local API and Telegram processor now share one profile-store instance in the combined host. The composition validates profile/lock/queue path separation and releases locks during shutdown.
- Added authenticated `GET /api/telegram/status`, sanitized to a fixed allowlist of operational fields, plus `client.telegramStatus()`.
- Telegram transaction mapping now reads the canonical profile context, filters hidden groups/categories, chooses a currently available category and account, and writes the account ID (not the display name).
- Added focused command/adapter test cases in `tests/telegram-finance-adapter.test.mjs` (not executed).
- The UI-side profile repository adapter preserves host-owned profile metadata during saves and checks the expected revision first, preventing routine UI saves from silently dropping Telegram replay checkpoints or legacy idempotency records.

Still blocked / incomplete:
- The combined host shares one profile store between API and Telegram. The browser can now import into the host, verify the read-back checksum, and explicitly select canonical storage; normal canonical startup uses the host-backed repository and refuses a silent IndexedDB fallback. The remaining blocker is end-to-end verification of migration, reconnect, conflict, and recovery behavior before enabling live financial writes.
- Category/group and account selection now resolve against the canonical profile, including hidden-category filtering and account IDs. User-configurable default choices and explicit account selection in command syntax remain.
- Added `scripts/setup-buildbook-telegram.ps1` as a guided Windows first-run setup and `scripts/setup-buildbook-telegram.bat` as a double-click launcher. It asks for the bot token and numeric Telegram user ID, generates the local API key, sets absolute data paths, backs up an existing `.env`, attempts to restrict its ACL, and keeps polling disabled. The BAT uses `ExecutionPolicy Bypass` for this single script invocation; run it only from a trusted local copy of the repository. The Telegram tab links to the BAT and explains how to place and run it. This is still not an in-app installer or OS-backed secret store; service installation/autostart remain incomplete. A browser cannot launch local scripts directly. The token remains in `.env`. The UI also includes local-host connection, service/queue status, profile import with preview and confirmation, read-back verification, and an explicit canonical-storage switch. The export-envelope utility is available in Settings as **Export for local host**; it creates a transfer file, while the separate ordinary backup remains available.
- The host/API/Telegram unit suite is now green in GitHub Actions: 181/181 tests passed on 2026-11-24. Browser checks still report eight existing application regressions across both `index.html` and the standalone build; these are tracked separately from the Telegram host unit suite.

### Current command format

- /доход 1250.50 Продажа
- /расход 450 Обед

Unknown or malformed commands are terminally rejected so they do not block later inbox items. The host-local calendar date is used for new entries.
