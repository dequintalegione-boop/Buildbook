# Browser profile migration to the local canonical store

## Status

The authenticated host import endpoint and browser-side export-envelope utility are implemented. The utility is `client/profile-export.js` and exposes `BuildbookProfileExport.createEnvelope(profile)` / `serialize(profile)`; it emits only state, logs, and photos, computes SHA-256 with Web Crypto, and does not include host metadata or credentials. It is loaded by the app and exposed as **Export for local host** in Settings; this creates a downloadable transfer file. Import preview/confirmation, backup verification, host import wiring, read-back verification, and storage-mode switching remain unimplemented. The browser UI remains on IndexedDB until backup verification, import preview/confirmation, read-back verification, startup selection, and recovery behavior are implemented and reviewed. Telegram finance writes must remain disabled while the UI and host can use different profiles.

## Safety invariants

1. Never silently replace a non-empty local profile with a host profile, or vice versa.
2. Never merge finance arrays by display name or timestamp. Records must retain stable IDs; ambiguous or duplicate IDs stop the migration.
3. A migration must not delete or mutate the source IndexedDB profile.
4. Create and verify a downloadable backup before importing. If backup creation or verification fails, abort before writing the host profile.
5. Import only into an empty canonical profile by default. Replacing a populated canonical profile requires an explicit separate recovery flow, not a normal startup action.
6. Preserve host-owned metadata (including Telegram idempotency records) only when the target profile is already canonical and the expected revision matches.
7. Treat imported JSON and binary photo descriptors as untrusted. Enforce size limits, validate the envelope and schema, and reject malformed or unsupported values.
8. Never include Telegram tokens, local API bearer credentials, or other host secrets in exports, import files, browser storage, or logs.
9. Do not enable the Telegram processor as a side effect of migration. Migration and service activation are separate user-confirmed actions.
10. Do not run migration tests until the user authorizes testing.

## Proposed user flow

1. User opens the local host setup screen and chooses **Import browser profile**.
2. The app reads the existing IndexedDB profile through the current repository, packages state/logs/photos using the same binary-safe transport format as the profile adapter, and asks the user to save a backup.
3. The app verifies that the backup file was created and is readable, then shows the source profile summary (record counts and schema version, without sensitive content).
4. The host validates the import envelope and reports whether the canonical profile is empty, its current revision, and any compatibility issues.
5. User confirms the import. The host performs a compare-and-swap write against the revision observed during validation. If the revision changed, abort and require a fresh review.
6. The app reads the canonical profile back and verifies the revision and stable record counts. Only then may the user choose **Use local host storage**.
7. The old IndexedDB profile remains intact as a rollback source. Rollback means switching the app back to IndexedDB; it does not copy newer canonical data over the old profile automatically.

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
