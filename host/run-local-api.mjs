import { createLocalApiHost } from './local-api-host.mjs';

const host = createLocalApiHost();

let stopping = false;

async function stop(signal) {
  if (stopping) return;
  stopping = true;
  console.info(`Buildbook local API: received ${signal}; shutting down.`);
  try {
    await host.stop();
    process.exitCode = 0;
  } catch (error) {
    console.error('Buildbook local API: shutdown failed.', error);
    process.exitCode = 1;
  }
}

process.once('SIGINT', () => { void stop('SIGINT'); });
process.once('SIGTERM', () => { void stop('SIGTERM'); });

try {
  const address = await host.start();
  console.info(`Buildbook local API listening on ${address.address}:${address.port}.`);
} catch (error) {
  console.error('Buildbook local API failed to start.', error);
  process.exitCode = 1;
}
