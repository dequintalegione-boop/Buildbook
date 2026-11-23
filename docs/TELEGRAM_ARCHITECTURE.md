# Telegram integration: architecture contract

## Components

1. **Buildbook UI** — configuration and monitoring only. It must not contain the bot token or implement Telegram polling.
2. **Local host service** — background process with startup/recovery support. Owns the bot token, Telegram polling, allowlist enforcement, durable inbox and processing status. The host composition accepts either an injected canonical domain adapter or a profile store plus the validated finance builder. `host/buildbook-local-host.mjs` composes the local API and Telegram service with the same profile-store instance and exclusive locks; `host/run-buildbook-local-host.mjs` is the combined entrypoint. The authenticated local API exposes a sanitized Telegram status endpoint. OS-level installation/autostart remains separate work.
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
- Use the Telegram update ID plus bot identity as a unique idempotency key.
- Process updates in order; persist the outcome and resulting Buildbook operation ID atomically where the storage design permits.
- If operation persistence fails, keep the inbox item pending and retry with bounded backoff; do not acknowledge it as completed in the UI.
- The canonical adapter must return a non-empty committed Buildbook operation ID (string or safe non-negative integer); missing/invalid IDs keep the inbox item pending. The inbox store independently rejects completion without this ID.
- On restart, resume pending items and skip items already committed.
- Verify the sender's numeric Telegram user ID against the allowlist before parsing or acting on the message. Unauthorized updates are ignored and are not written into the financial domain.
- The processor treats persisted inbox JSON as untrusted and reconstructs a minimal private-text envelope before invoking the canonical adapter; extra fields in a tampered record are never forwarded. Numeric bot/user IDs and the idempotency key must also be canonical decimal forms, preventing leading-zero identity aliases.
- Keep a minimal technical record for rejected/accepted update processing; avoid retaining unnecessary message text or personal data.

## Token and configuration

- The bot token is a secret and must be stored by the host service in an OS-protected local secret store or a restricted local configuration file, never in the web app bundle, browser localStorage, or Git.
- The current local API uses a host-only bearer token and does not yet provide UI setup or token provisioning. The service must not return the token in status responses or logs.
- Bind the local control API to loopback only; protect configuration-changing requests against cross-site requests and validate the expected local origin.
- Allowlist entries are numeric Telegram user IDs, normalized and validated by the service.

## Host and storage decision

The current app uses browser IndexedDB, which is unavailable to a separate background process when the browser is closed. The local service therefore cannot safely write financial records into the current browser database directly.

The combined local host now shares one file-backed profile store between its API and Telegram processor. The browser UI still initializes directly from IndexedDB; the repository adapter is not yet wired into app startup, and a recoverable migration/bootstrap path is not complete. Until that is finished, do not treat the browser UI and host as one live ledger or enable Telegram writes against a separate profile.

## Outage caveat

The durable inbox protects updates only after the local service has received and persisted them. Telegram retains pending bot updates for a limited period (up to 24 hours); if the local host is offline longer, Telegram may discard updates before the service can receive them. A separate always-on receiver is required to guarantee capture through longer local outages.
