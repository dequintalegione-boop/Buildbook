# Telegram UI / allowlist finish

Applied on the working tree:

- `telegramAllowlistEditor()` is defined in `index.html` and wired via `data-a="tgallowlist"` in the main action map.
- `client/telegram-overrides.js` is a capture-phase safety net only.
- First-run and connect copy explain that `BUILDBOOK_LOCAL_API_TOKEN` is host-only, auto-generated, and not entered when the UI is served from the host.
- Allowlist API remains `GET`/`PUT` `/api/telegram/allowlist` in `host/local-api.mjs` with live gate update through `setAllowlist`.

No separate `git apply` step is required for these UI pieces.
