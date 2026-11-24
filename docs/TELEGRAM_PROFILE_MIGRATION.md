# Browser profile migration to the local canonical store

## Status

The authenticated host import endpoint, browser export-envelope utility, and guarded browser-to-host import flow are implemented. The export utility is `client/profile-export.js` and exposes `BuildbookProfileExport.createEnvelope(profile)` / `serialize(profile)`; it exports only state/logs/photos, computes SHA-256 with Web Crypto, and excludes host metadata and credentials. Settings lets the user select a transfer file, validate its schema/size/checksum, confirm that a separate ordinary backup has been saved, inspect the source record counts, and check that the authenticated local host profile is empty. Import uses the observed target revision (compare-and-swap), then reads the profile back and verifies its SHA-256 digest. The original IndexedDB profile is not changed. The backup prompt is a user attestation; the browser cannot independently prove that a downloaded backup was saved to durable storage.

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
4. The app authenticates to the already-connected local host, reads its canonical profile, and refuses to continue unless the target is empty. It displays schema/date/size and record counts before the final confirmation.
5. User confirms the import. The host performs a compare-and-swap write against the observed revision. If the revision changed or the target became non-empty, the import is rejected.
6. The app reads the canonical profile back and verifies the new revision and SHA-256 digest. A mismatch is reported as a recovery issue; the app does not switch storage.
7. The old IndexedDB profile remains intact. The app continues using IndexedDB until a separate reviewed storage-mode/startup-selection stage is implemented.

## Import envelope

The current host import endpoint is `POST /api/profile/import` (authenticated, loopback-only). It accepts the version-1 envelope below only for source schema version 5 and imports only into an empty canonical profile. The API body limit is 34 MiB; the profile store independently enforces its 32 MiB profile limit. The endpoint returns a revision on success, HTTP 409 for a populated target or revision conflict, and rejects unsupported schemas or checksum mismatches without writing.

The envelope should contain only:
- a fixed format identifier and version;
- source schema version and export timestamp;
- profile state, logs, and photos;
- a lowercase SHA-256 integrity digest over `JSON.stringify(payload)`.

It must not contain a caller-selected destination path, host metadata, Telegram inbox records, tokens, API credentials, or arbitrary executable content. The host computes its own destination and revision.

## Conflict and recovery behavior

- Empty canonical profile + valid backup + matching expected revision: allow import.
- Non-empty canonical profile: refuse normal import and offer export/backup or a separately designed recovery procedure.
- Unsupported schema, invalid binary descriptor, oversized payload, digest mismatch, duplicate stable IDs, or malformed JSON: reject without changing the canonical profile.
- Revision conflict during import: reject without retrying against the new revision; require the user to review the current target again.
- Interrupted import: atomic profile-store replacement must leave either the old complete profile or the new complete profile, never a partial profile.
- Post-import verification failure: retain the backup and source IndexedDB; display a recovery error and do not switch the UI to the host repository.

## Implementation sequence

1. [Implemented] Add a version-1 import envelope validator and authenticated host import operation; accept only schema version 5, verify SHA-256, require an empty target, and use revision compare-and-swap.
3. Add an explicit UI backup/export step and confirmation screen.
4. Add host import preview and confirmation, with no automatic startup migration.
5. Add a storage-mode selector that is enabled only after successful read-back verification.
6. Add rollback guidance and Windows recovery instructions.
7. Perform static review; execute tests only after the user authorizes them.
