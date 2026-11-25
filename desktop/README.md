# Buildbook desktop (initial shell)

This Electron shell opens the existing Buildbook interface in a desktop window and starts the existing local host as a child process. The host is restarted after an unexpected exit and is stopped when the app quits.

## Development

1. Install Node.js 20 or newer.
2. Run `npm install` in the repository root.
3. Run `npm run desktop`.

## Windows installer

Run `npm run desktop:dist`. The installer output is written by electron-builder to `dist/`.

## Notes

- The desktop shell does not require the user to manually start the local host or enter the host key for the host process it launches.
- Telegram bot token setup remains in the existing Buildbook interface and is still an explicit user action.
- Installing a Windows service or configuring machine-wide startup is not part of this first shell. Those actions need a separately confirmed installer/elevation flow.
- This initial shell has not yet been packaged or exercised on Windows. Verify local-host startup, app close/reopen, Telegram setup, and installer behavior on a Windows machine before distributing it.
