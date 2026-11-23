/**
 * Coordinates durable Telegram reception and inbox processing.
 * The host lifecycle owns scheduling; this module intentionally has no timer or
 * process-global state, so it can be embedded in a CLI service or tested directly.
 */
export function createTelegramRuntime({ inbox, poller, processor } = {}) {
  if (!inbox || typeof inbox.recoverInterrupted !== 'function' || typeof inbox.stats !== 'function') {
    throw new TypeError('A recoverable durable Telegram inbox is required.');
  }
  if (!poller || typeof poller.pollOnce !== 'function') throw new TypeError('A Telegram poller is required.');
  if (!processor || typeof processor.processOne !== 'function') throw new TypeError('A Telegram inbox processor is required.');

  let active = false;
  let recovered = false;

  async function runOnce(options = {}) {
    if (active) throw new Error('Telegram runtime cycle is already in progress.');
    active = true;
    try {
      if (!recovered) {
        await inbox.recoverInterrupted();
        recovered = true;
      }

      const polling = await poller.pollOnce(options);
      let processed = 0;
      while (true) {
        const result = await processor.processOne();
        if (!result.processed) break;
        processed += 1;
      }
      return { polling, processed, inbox: await inbox.stats() };
    } finally {
      active = false;
    }
  }

  return Object.freeze({ runOnce });
}
