# Browser profile migration to the local canonical store

## Status

The authenticated host import endpoint, browser export-envelope utility, and guarded browser-to-host import flow are implemented. The export utility is `client/profile-export.js` and exposes `BuildbookProfileExport.createEnvelope(profile)` / `serialize(profile)`; it exports only state/logs/photos, computes SHA-256 with Web Crypto, and excludes host metadata and credentials. Settings lets the user select a transfer file, validate its schema/size/checksum, confirm that a separate ordinary browser backup has been saved, inspect source record counts, and read the authenticated local host profile. If the host profile is populated, the UI automatically downloads a separate full-profile backup containing its revision and SHA-256 digest, asks the user to confirm that the file was saved, and offers an explicit replacement confirmation. The replacement endpoint verifies that the backup digest still matches the current host profile and uses the observed revision (compare-and-swap) before writing; it then reads the profile back and verifies the imported SHA-256 digest. The original IndexedDB profile is not changed. The backup prompt is a user attestation; the browser cannot independently prove that a downloaded backup was saved to durable storage.

The ordinary UI can then switch to that canonical profile after an explicit confirmation. Startup uses the session-cookie runtime, fails closed when the session or profile is unavailable, and does not fall back to IndexedDB. Switching back is a separate explicit action. `Buildbook-standalone.html` and `?test=1` stay on IndexedDB. Telegram polling remains off until the operator sets `BUILDBOOK_TELEGRAM_ENABLED=true` after checking that the UI is on this same profile. Automatic verification of the backup file on disk, and a separate Windows service installer, are still not implemented.

## Safety invariants

1. Never silently replace a non-empty local profile with a host profile, or vice versa.
2. Never merge finance arrays by display name or timestamp. Records must retain stable IDs; ambiguous or duplicate IDs stop the migration.
3. A migration must not delete or mutate the source IndexedDB profile.
4. Require a separate ordinary backup before importing. The UI asks the user to confirm it was saved, but cannot independently verify the downloaded file; if the user cannot confirm, abort before writing the host profile.
5. Import only into an empty canonical profile by default. Replacing a populated canonical profile requires an explicit separate recovery flow, not a normal startup action.
6. Preserve host-owned metadata (including Telegram idempotency records) only when the target profile is already canonical and the expected revision matches.
7. Treat imported JSON and binary photo descriptors as untrusted. Enforce size limits, validate the envelope and schema, and reject malformed or unsupported values.
8. Never include Telegram tokens, local API bearer credentials, or other host secrets in exports, import files, browser storage, or logs.
9. Do not enable the Telegram processor as a side effect of migration. Migration and service activation are separate user-confirmed actions.
10. Do not run migration tests until the user authorizes testing.

## Proposed user flow

1. User downloads a separate ordinary JSON backup and the dedicated **Export for local host** transfer file from Settings.
2. User selects the transfer file with **Проверить файл переноса**. The app validates the format, schema version, size limit, and SHA-256 digest before contacting the host.
3. The app asks the user to confirm that the separate backup was saved. This is an explicit user attestation, not an automated filesystem verification.
4. The app authenticates to the already-connected local host and reads its canonical profile. If it is populated, the app exports the user-data fields (state, logs, photos) to a separate JSON backup, excluding host metadata and credentials, including the observed revision and SHA-256 digest, and asks the user to confirm that the file was saved.
5. The app displays source schema/date/size and record counts, then asks for a separate final confirmation. For a populated target, the host verifies that the backup digest matches the exact current profile and performs a compare-and-swap replacement. If the target changed after backup or the digest differs, the operation is rejected without writing.
6. The app reads the canonical profile back and verifies the new revision and SHA-256 digest. A mismatch is reported as a recovery issue; the app does not switch storage.
7. The old IndexedDB profile remains intact. The app continues using IndexedDB until a separate reviewed storage-mode/startup-selection stage is implemented.

## Import envelope

The normal host import endpoint is `POST /api/profile/import` (authenticated, loopback-only). It accepts the version-1 envelope below only for source schema version 5 and imports only into an empty canonical profile. The separate recovery endpoint is `POST /api/profile/replace`; it requires the exact current target revision and the SHA-256 digest of a separately exported target user-data backup before replacing a populated profile. Both endpoints enforce the 34 MiB API body limit and 32 MiB profile limit, validate the envelope, and verify the resulting profile by reading it back. A stale revision or backup mismatch returns HTTP 409 without writing.

The envelope should contain only:
- a fixed format identifier and version;
- source schema version and export timestamp;
- profile state, logs, and photos;
- a lowercase SHA-256 integrity digest over `JSON.stringify(payload)`.

It must not contain a caller-selected destination path, host metadata, Telegram inbox records, tokens, API credentials, or arbitrary executable content. The host computes its own destination and revision.

## Conflict and recovery behavior

- Empty canonical profile + valid backup + matching expected revision: allow import.
- Non-empty canonical profile: refuse the normal import endpoint. The recovery endpoint allows replacement only when the submitted backup digest matches the exact current target user-data snapshot and the expected revision still matches.
- Unsupported schema, invalid binary descriptor, oversized payload, digest mismatch, duplicate stable IDs, or malformed JSON: reject without changing the canonical profile.
- Revision conflict during import: reject without retrying against the new revision; require the user to review the current target again.
- Interrupted import: atomic profile-store replacement must leave either the old complete profile or the new complete profile, never a partial profile.
- Post-import verification failure: retain the backup and source IndexedDB; display a recovery error and do not switch the UI to the host repository.

## Implementation status

1. [Implemented] Version-1 transfer-envelope validation and authenticated host import; schema 5, SHA-256, empty-target requirement, and revision compare-and-swap.
2. [Implemented] Separate authenticated recovery endpoint for populated targets; it verifies the exported target user-data backup digest and expected revision before replacement, then verifies the read-back profile.
3. [Implemented] Separate browser backup/export flow and explicit user confirmations before transfer.
4. [Implemented] Import preview, confirmation, host-side import, and browser read-back/checksum verification. The source IndexedDB profile is not modified.
5. [Implemented] The UI offers a separate storage-mode switch only after successful verification. The existing IndexedDB profile remains untouched as a fallback/backup; the standalone build continues to use IndexedDB.
6. [Documented] Recovery behavior for conflicts, expired sessions, and failed verification is described in the local API and setup guides. Confirm the Windows recovery procedure on a real Windows machine before release.
7. [Pending] End-to-end verification on Windows with a real local profile and Telegram bot, including restart/recovery scenarios.
8. Tests have not been run in this work session. Run the relevant suites only after the user authorizes testing.
