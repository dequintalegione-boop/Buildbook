# Apply remaining Telegram UI / allowlist finish

Already on `main` from previous merge:
- dynamic allowlist gate, host service, handlers, routes module
- auto-generate API token on first host start
- bot ID validation + SW test fix

## 1. Wire local-api routes (required for GET/POST /api/telegram/allowlist)

From repo root:

```bash
node scripts/apply-allowlist-local-api.mjs
```

This is idempotent. It adds import, signature params, validation, and the route dispatch for `handleTelegramAllowlistRoutes`.

## 2. UI changes in index.html

The full UI patch is prepared locally (allowlist table editor, connect-key help, first-run buttons). Apply after pulling this branch:

```bash
# if you have the patch file with full content:
git apply patches/telegram-ui-allowlist-index.patch
```

If the patch file is still a placeholder, re-run the UI changes from the assistant session or request a follow-up push of `index.html`.

## Verify

```bash
node --test tests/*.test.mjs
```
