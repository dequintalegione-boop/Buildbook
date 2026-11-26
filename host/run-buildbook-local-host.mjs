import { createBuildbookLocalHost } from './buildbook-local-host.mjs';

let host;
let stopping = false;

async function stop(signal) {
  if (stopping) return;
  stopping = true;
  console.info(`Buildbook local host: received ${signal}; shutting down.`);
  try {
    if (host) await host.stop();
    process.exitCode = 0;
  } catch (error) {
    console.error('Buildbook local host: shutdown failed.', error?.message || 'Unknown error');
    process.exitCode = 1;
  }
}

process.once('SIGINT', () => { void stop('SIGINT'); });
process.once('SIGTERM', () => { void stop('SIGTERM'); });
// Covers ordinary fatal exits and explicit process.exit(). SIGKILL and power
// loss cannot run exit hooks; those cases remain fail-closed rather than
// deleting a lock whose owner has not been verified.
process.once('exit', () => {
  try { host?.releaseLocksOnExit?.(); } catch {}
});

try {
  host = createBuildbookLocalHost({
    onError(error) {
      // Never print request bodies or Telegram tokens from arbitrary errors.
      console.error('Buildbook Telegram service error:', error?.code || error?.name || 'Unknown error');
    },
  });
  const address = await host.start();
  console.info(`Buildbook local web/API host listening on http://${address.address.includes(':') ? '[' + address.address + ']' : address.address}:${address.port}/; Telegram ${host.telegramStatus.enabled ? 'service started' : 'disabled until explicitly enabled'}.`);
} catch (error) {
  console.error('Buildbook local host failed to start.', error?.message || error);
  process.exitCode = 1;
}
