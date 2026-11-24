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
8. Store a per-bot monotonic replay checkpoint with each finance operation in the same canonical commit; retain exact-key legacy ledger compatibility.
9. Ensure duplicate/replayed update IDs at or below the checkpoint cannot add another transaction; process accepted updates serially in increasing update-ID order.
10. Ensure profile revision conflicts cause a bounded retry, not a second operation.
11. Add the canonical finance adapter behind the existing `applyUpdate` boundary.
12. Keep adapter failures generic in durable inbox state and redact sensitive details from logs.
13. Connect the adapter to the host composition without introducing a second finance ledger.
14. Add a status endpoint that exposes only bounded, sanitized service state.
15. Add local UI client support for status and setup, without embedding the bot token in the app bundle.
16. Define safe first-run token provisioning and protected local secret storage.
17. Add an explicit migration/import path from browser IndexedDB to the shared canonical profile, with backup and conflict handling. Design contract: [TELEGRAM_PROFILE_MIGRATION.md](./TELEGRAM_PROFILE_MIGRATION.md). The authenticated host import endpoint is implemented; browser export/backup UI, preview/confirmation, read-back verification, and storage-mode switching remain.
18. Keep browser-only and standalone modes functional when the local host is not configured.
19. Add documented Windows launch/stop and recovery instructions; defer OS autostart until the lifecycle is verified.
20. Perform a code review of the full data path, then run the existing and new tests only after the user authorizes testing.

## Blocking architecture decision

The current browser app stores its profile in IndexedDB, while the Telegram host uses a separate file-backed profile store. The host must not write financial operations to a second ledger. The canonical finance adapter is implemented against the host profile store. The remaining blocker is ensuring the browser UI is switched to that same canonical storage boundary through the deliberate, recoverable migration path before enabling Telegram writes.

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
- The combined host shares one profile store between API and Telegram, but the UI still starts with browser IndexedDB. The repository adapter is not yet wired into the app startup path; do not treat the UI and host as one live ledger until that switch/migration is implemented and exercised.
- Category/group and account selection now resolve against the canonical profile, including hidden-category filtering and account IDs. User-configurable default choices and explicit account selection in command syntax remain.
- UI setup, safe token provisioning, browser export/backup UI, import preview/confirmation, post-import verification, storage-mode switching, and service installation/autostart remain. The browser export-envelope utility at `client/profile-export.js` is loaded and exposed in Settings as **Export for local host**; it downloads the transfer envelope but does not import it into the host. The authenticated import endpoint is implemented but not yet wired to UI. Status is available from the authenticated local API but not yet displayed in the app.
- The host/API/Telegram unit suite is now green in GitHub Actions: 181/181 tests passed on 2026-11-24. Browser checks still report eight existing application regressions across both `index.html` and the standalone build; these are tracked separately from the Telegram host unit suite.

### Current command format

- /доход 1250.50 Продажа
- /расход 450 Обед

Unknown or malformed commands are terminally rejected so they do not block later inbox items. The host-local calendar date is used for new entries.
