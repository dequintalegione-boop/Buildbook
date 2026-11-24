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

  async function drainInbox() {
    let processed = 0;
    while (true) {
      const result = await processor.processOne();
      if (!result.processed) break;
      processed += 1;
    }
    return processed;
  }

  async function runOnce(options = {}) {
    if (active) throw new Error('Telegram runtime cycle is already in progress.');
    active = true;
    try {
      if (!recovered) {
        await inbox.recoverInterrupted();
        recovered = true;
      }

      // Drain durable work before network I/O: a Telegram outage must not block
      // updates already accepted into the local inbox.
      let processed = await drainInbox();
      const polling = await poller.pollOnce(options);
      processed += await drainInbox();

      // pollOnce returns only after the offset file has been durably committed.
      // Compacting terminal entries below that checkpoint bounds inbox growth
      // without dropping retryable work or relying on a volatile poll result.
      if (typeof inbox.compactAcknowledged === 'function'
        && Number.isSafeInteger(polling.nextOffset) && polling.nextOffset >= 0) {
        await inbox.compactAcknowledged(polling.nextOffset);
      }

      return { polling, processed, inbox: await inbox.stats() };
    } finally {
      active = false;
    }
  }

  return Object.freeze({ runOnce });
}
