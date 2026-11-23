/**
 * Installs process signal handling for an already-composed Telegram host.
 *
 * The caller must supply a host created with the real canonical Buildbook
 * adapter. This module deliberately does not load secrets, create storage, or
 * invent a domain adapter.
 */
export function installTelegramHostLifecycle({ host, processRef = process, onError = () => {} } = {}) {
  if (!host || !host.service || typeof host.service.start !== 'function'
    || typeof host.service.stop !== 'function') {
    throw new TypeError('A composed Telegram host service is required.');
  }
  if (!processRef || typeof processRef.once !== 'function'
    || typeof processRef.removeListener !== 'function') {
    throw new TypeError('A process-like signal target is required.');
  }
  if (typeof onError !== 'function') throw new TypeError('onError must be a function.');

  let stopping = null;
  let started = false;

  const stop = async (signal = 'shutdown') => {
    if (stopping) return stopping;
    stopping = (async () => {
      try {
        await host.service.stop();
        return { stopped: true, signal };
      } catch (error) {
        try { onError(error, { phase: 'shutdown', signal }); } catch {}
        throw error;
      } finally {
        processRef.removeListener('SIGINT', onSigint);
        processRef.removeListener('SIGTERM', onSigterm);
        started = false;
      }
    })();
    return stopping;
  };

  const onSigint = () => { void stop('SIGINT').catch(() => {}); };
  const onSigterm = () => { void stop('SIGTERM').catch(() => {}); };

  return Object.freeze({
    start() {
      if (started) return;
      if (stopping) throw new Error('Telegram host is shutting down.');
      // Register before starting so a signal cannot be missed during startup.
      processRef.once('SIGINT', onSigint);
      processRef.once('SIGTERM', onSigterm);
      try {
        const loop = host.service.start();
        started = true;
        // The service start promise resolves only when its lifecycle ends.
        void loop.catch(error => {
          try { onError(error, { phase: 'service-loop' }); } catch {}
        });
      } catch (error) {
        processRef.removeListener('SIGINT', onSigint);
        processRef.removeListener('SIGTERM', onSigterm);
        throw error;
      }
    },
    stop,
    get running() { return started && !stopping; },
  });
}
