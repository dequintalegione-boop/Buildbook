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

try {
  host = createBuildbookLocalHost({
    onError(error) {
      // Never print request bodies or Telegram tokens from arbitrary errors.
      console.error('Buildbook Telegram service error:', error?.code || error?.name || 'Unknown error');
    },
  });
  const address = await host.start();
  console.info(`Buildbook local API listening on ${address.address}:${address.port}; Telegram ${host.telegramStatus.enabled ? 'service started' : 'disabled until explicitly enabled'}.`);
} catch (error) {
  console.error('Buildbook local host failed to start.', error?.message || error);
  process.exitCode = 1;
}
