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

  function throwIfAborted(signal) {
    if (signal?.aborted) throw signal.reason || new Error('Telegram runtime was aborted.');
  }

  async function drainInbox(signal) {
    let processed = 0;
    while (true) {
      throwIfAborted(signal);
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
      throwIfAborted(options.signal);
      if (!recovered) {
        await inbox.recoverInterrupted();
        throwIfAborted(options.signal);
        recovered = true;
      }

      // Drain durable work before network I/O: a Telegram outage must not block
      // updates already accepted into the local inbox.
      let processed = await drainInbox(options.signal);

      // Free acknowledged terminal rows before receiving more updates. This
      // prevents a full inbox from blocking the very poll cycle that would
      // otherwise compact it. readCheckpoint comes from the durable offset store.
      if (typeof inbox.compactAcknowledged === 'function'
        && typeof poller.readCheckpoint === 'function') {
        const checkpoint = await poller.readCheckpoint();
        if (Number.isSafeInteger(checkpoint) && checkpoint >= 0) {
          await inbox.compactAcknowledged(checkpoint);
        }
      }

      throwIfAborted(options.signal);
      const polling = await poller.pollOnce(options);
      throwIfAborted(options.signal);
      processed += await drainInbox(options.signal);

      // pollOnce returns only after the offset file has been durably committed.
      // Compact newly terminal rows using that confirmed checkpoint as well.
      if (typeof inbox.compactAcknowledged === 'function'
        && Number.isSafeInteger(polling?.nextOffset) && polling.nextOffset >= 0) {
        await inbox.compactAcknowledged(polling.nextOffset);
      }

      return { polling, processed, inbox: await inbox.stats() };
    } finally {
      active = false;
    }
  }

  return Object.freeze({ runOnce });
}
