/**
 * Owns the lifecycle loop around the Telegram runtime.
 * Keep this process under the OS service manager for startup-after-reboot behavior.
 */
function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason || new Error('Telegram service stopped.'));
    const timer = setTimeout(done, ms);
    function done() {
      signal.removeEventListener('abort', abort);
      resolve();
    }
    function abort() {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(signal.reason || new Error('Telegram service stopped.'));
    }
    signal.addEventListener('abort', abort, { once: true });
  });
}

export function createTelegramService({
  runtime,
  intervalMs = 1000,
  retryBaseMs = 1000,
  retryMaxMs = 60000,
  onCycle = () => {},
  onError = () => {},
  acquireInstanceLock = null,
} = {}) {
  if (!runtime || typeof runtime.runOnce !== 'function') throw new TypeError('A Telegram runtime is required.');
  for (const [name, value] of Object.entries({ intervalMs, retryBaseMs, retryMaxMs })) {
    if (!Number.isSafeInteger(value) || value < 100) {
      throw new TypeError(name + ' must be a safe integer of at least 100 milliseconds.');
    }
  }
  if (retryMaxMs < retryBaseMs) throw new TypeError('retryMaxMs must be at least retryBaseMs.');
  if (typeof onCycle !== 'function' || typeof onError !== 'function') throw new TypeError('Service callbacks must be functions.');
  if (acquireInstanceLock !== null && typeof acquireInstanceLock !== 'function') throw new TypeError('acquireInstanceLock must be a function.');

  let controller = null;
  let loopPromise = null;
  let releaseInstanceLock = null;

  async function loop(signal) {
    let failures = 0;
    while (!signal.aborted) {
      try {
        const result = await runtime.runOnce({ signal });
        failures = 0;
        try { onCycle(result); } catch (error) {
          // UI/metrics callbacks must not turn a successful poll into a failed cycle.
          try { onError(error, { failures: 0, phase: 'onCycle' }); } catch {}
        }
        await wait(intervalMs, signal);
      } catch (error) {
        if (signal.aborted) break;
        failures += 1;
        try { onError(error, { failures }); } catch {}
        const delay = Math.min(retryMaxMs, retryBaseMs * (2 ** Math.min(failures - 1, 30)));
        try { await wait(delay, signal); } catch { break; }
      }
    }
  }

  return Object.freeze({
    start() {
      if (loopPromise) return loopPromise;
      // Acquire synchronously before exposing a running lifecycle. The supplied
      // lock callback must fail closed if another process owns the service.
      try {
        releaseInstanceLock = acquireInstanceLock ? acquireInstanceLock() : null;
        if (releaseInstanceLock && typeof releaseInstanceLock !== 'function') {
          throw new TypeError('Instance-lock acquisition must return a release function.');
        }
      } catch (error) {
        releaseInstanceLock = null;
        throw error;
      }
      controller = new AbortController();
      loopPromise = loop(controller.signal).finally(() => {
        try { releaseInstanceLock?.(); } finally {
          releaseInstanceLock = null;
          controller = null;
          loopPromise = null;
        }
      });
      return loopPromise;
    },
    async stop() {
      if (!controller || !loopPromise) return;
      controller.abort(new Error('Telegram service stopped.'));
      await loopPromise;
    },
    get running() { return loopPromise !== null; },
  });
}
