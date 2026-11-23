import { createLocalApiHost } from './local-api-host.mjs';

let host;
let stopping = false;

async function stop(signal) {
  if (stopping) return;
  stopping = true;
  console.info(`Buildbook local API: received ${signal}; shutting down.`);
  try {
    if (host) await host.stop();
    process.exitCode = 0;
  } catch (error) {
    console.error('Buildbook local API: shutdown failed.', error);
    process.exitCode = 1;
  }
}

process.once('SIGINT', () => { void stop('SIGINT'); });
process.once('SIGTERM', () => { void stop('SIGTERM'); });

try {
  host = createLocalApiHost();
  const address = await host.start();
  console.info(`Buildbook local API listening on ${address.address}:${address.port}.`);
} catch (error) {
  console.error('Buildbook local API failed to start.', error.message || error);
  process.exitCode = 1;
}
