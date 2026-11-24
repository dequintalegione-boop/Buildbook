# Telegram integration: architecture contract

## Components

1. **Buildbook UI** — configuration and monitoring only. It must not contain the bot token or implement Telegram polling.
2. **Local host service** — background process with startup/recovery support. Owns the bot token, Telegram polling, allowlist enforcement, durable inbox and processing status. The host composition accepts either an injected canonical domain adapter or a profile store plus the validated command adapter. `host/buildbook-local-host.mjs` composes the local API and Telegram service with the same profile-store instance and exclusive locks; `host/run-buildbook-local-host.mjs` is the combined entrypoint. The authenticated local API exposes a sanitized Telegram status endpoint. Windows autostart is a per-user scheduled task; a full Windows service installer remains separate work.
3. **Telegram adapter** — converts Telegram updates and callback actions into validated domain commands.
4. **Buildbook storage adapter** — the only component allowed to persist financial operations. It must target the same canonical data store used by the app.
5. **Host adapter boundary** — separates local process lifecycle and transport from the domain/inbox logic, so a remote host can be substituted later.

## Inbox and delivery semantics

- Store each accepted Telegram update durably before advancing the Telegram polling offset.
- Inbox mutations use copy-on-write snapshots: a failed disk replacement must leave the cached deduplication state unchanged, so retrying the same update cannot be mistaken for a durable duplicate.
- Inbox storage itself replaces caller-supplied processing/rejection error text with fixed summaries; sanitization does not depend on every caller remembering to redact.
- The durable inbox has a 64 MiB file ceiling checked on load and before atomic replacement; when full it fails closed rather than consuming unbounded disk or acknowledging unpersisted updates.
- On load, inbox records are schema-checked for valid states, unique IDs/keys and consistent identity metadata; malformed files fail closed. Inbox and offset files must be regular files, not symbolic links or special filesystem objects.
- Enforce inbox state transitions (`pending → processing → pending|completed|rejected`); completed/rejected records are terminal, and repeated completion is idempotent only for the same operation ID.
- Use the Telegram update ID plus bot identity as the idempotency key. New financial writes atomically advance a per-bot monotonic replay checkpoint in the same profile revision; exact legacy keys remain readable for compatibility.
- New Telegram finance writes atomically advance a per-bot replay checkpoint in the canonical profile alongside the transaction, instead of appending a key to the legacy idempotency array. The checkpoint is safe only because the host processes accepted updates serially in increasing Telegram update-ID order; do not bypass that processor or reset checkpoints. Existing `telegramOperations` entries remain supported and are used to seed the checkpoint on the next successful write. The legacy array remains capped at 100,000 entries, but new writes no longer grow it.
- Process updates in order; persist the outcome and resulting Buildbook operation ID atomically where the storage design permits.
- If operation persistence fails, keep the inbox item pending and retry with bounded backoff; do not acknowledge it as completed in the UI.
- The canonical adapter must return a non-empty operation ID (string or safe non-negative integer); missing/invalid IDs keep the inbox item pending. A replay below the durable per-bot checkpoint may return a synthetic completion marker because its original operation ID is not needed to prevent a second write. The inbox store independently rejects completion without an ID.
- On restart, resume pending items and skip items already committed.
- Verify the sender's numeric Telegram user ID against the allowlist before parsing or acting on the message. Unauthorized updates are ignored and are not written into the financial domain.
- The processor treats persisted inbox JSON as untrusted and reconstructs a minimal private-text envelope before invoking the canonical adapter; extra fields in a tampered record are never forwarded. Numeric bot/user IDs and the idempotency key must also be canonical decimal forms, preventing leading-zero identity aliases.
- After a command succeeds, the host may call `sendMessage` for that same allowlisted private chat. The reply is attempted before the inbox item is marked complete. A failed reply leaves the item pending and retries the idempotent command; it must not advance as completed. Unauthorized senders still receive no reply. Reply failures are reported with a fixed error and must not log the bot token.
- `/доход` and `/расход` (and the English aliases) write one income or expense. `/статистика` and `/статистика YYYY-MM` only read the same canonical profile and do not append a transaction. `/help` is read-only. Plain text is discarded without a reply. Month totals follow the UI summary: kinds `i` and `e` only, excluding deleted records, loans, transfers and investments.
- Keep a minimal technical record for rejected/accepted update processing; avoid retaining unnecessary message text or personal data.

## Token and configuration

- The bot token is a secret and must be stored by the host service in an OS-protected local secret store or a restricted local configuration file, never in the web app bundle, browser localStorage, or Git.
- The Buildbook UI has a Telegram tab for one-time host-session bootstrap and sanitized status/queue monitoring. The bootstrap key is exchanged for an HttpOnly browser session and is not stored in the app. The bot token remains host-only; the UI does not configure or reveal it. The regular browser UI can now use the canonical file-backed profile after the user explicitly imports and verifies the profile, confirms the switch, and establishes a valid host session. Keep `BUILDBOOK_TELEGRAM_ENABLED=false` until the operator has verified that the browser UI is using that same canonical profile; the flag remains an explicit host-side setting. The service must not return the token in status responses or logs.
- Bind the local control API to loopback only; protect configuration-changing requests against cross-site requests and validate the expected local origin.
- Allowlist entries are numeric Telegram user IDs, normalized and validated by the service.

## Host and storage decision

The app supports two explicit storage modes. The default and standalone/test mode use browser IndexedDB. In the regular browser UI, the user can connect to the loopback host, export a migration package, import it only into an empty canonical file-backed profile, verify the read-back checksum, and explicitly confirm switching modes. The UI then initializes through the canonical repository adapter and uses the same profile-store instance as the Telegram processor. If the session/API is unavailable or the canonical profile is empty, startup fails closed; there is no automatic IndexedDB fallback. Switching back to IndexedDB is a separate explicit action, and the two profiles remain independent.

Telegram polling remains disabled by default (`BUILDBOOK_TELEGRAM_ENABLED=false`). Enable it only after confirming the browser UI is actively using the same canonical profile. The migration leaves the original IndexedDB profile untouched as a user-controlled backup. The standalone HTML and `?test=1` continue to use IndexedDB.

## Outage caveat

The durable inbox protects updates only after the local service has received and persisted them. Telegram retains pending bot updates for a limited period (up to 24 hours); if the local host is offline longer, Telegram may discard updates before the service can receive them. A separate always-on receiver is required to guarantee capture through longer local outages.
