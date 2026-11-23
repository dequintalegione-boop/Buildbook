import { createInboxStore } from './inbox-store.mjs';
import { createTelegramOffsetStore } from './telegram-offset-store.mjs';
import { createTelegramUpdateGate } from './telegram-update-gate.mjs';
import { createTelegramPoller } from './telegram-poller.mjs';
import { createTelegramInboxProcessor } from './telegram-inbox-processor.mjs';
import { createTelegramRuntime } from './telegram-runtime.mjs';
import { createTelegramService } from './telegram-service.mjs';
import { acquireInstanceLock } from './instance-lock.mjs';
import { createTelegramStatus } from './telegram-status.mjs';

/**
 * Compose the Telegram host from validated host-only configuration and the
 * canonical Buildbook write adapter. This factory intentionally does not
 * invent a finance adapter: callers must provide the app's real idempotent
 * storage boundary before starting the service.
 */
export function createTelegramHostService({
  config,
  applyUpdate,
  fetchImpl = globalThis.fetch,
  onCycle = () => {},
  onError = () => {},
} = {}) {
  if (!config || typeof config !== 'object') throw new TypeError('Validated Telegram host config is required.');
  if (typeof applyUpdate !== 'function') {
    throw new TypeError('The canonical Buildbook finance adapter is required before Telegram processing can start.');
  }
  if (typeof config.botToken !== 'string' || !config.botToken
    || typeof config.botId !== 'string' || !config.botId
    || !Array.isArray(config.allowedUserIds)
    || typeof config.inboxPath !== 'string'
    || typeof config.offsetPath !== 'string'
    || typeof config.instanceLockPath !== 'string') {
    throw new TypeError('Telegram host config is incomplete.');
  }

  const status = createTelegramStatus();
  const inbox = createInboxStore(config.inboxPath);
  const offsetStore = createTelegramOffsetStore(config.offsetPath);
  const gate = createTelegramUpdateGate({ inbox, botId: config.botId, allowlist: config.allowedUserIds });
  const poller = createTelegramPoller({
    botToken: config.botToken,
    gate,
    offsetStore,
    fetchImpl,
    timeoutSeconds: config.timeoutSeconds,
  });
  const processor = createTelegramInboxProcessor({ inbox, applyUpdate });
  const runtime = createTelegramRuntime({ inbox, poller, processor });

  const service = createTelegramService({
    runtime,
    intervalMs: config.intervalMs,
    retryBaseMs: config.retryBaseMs,
    retryMaxMs: config.retryMaxMs,
    onCycle(result) {
      status.cycle(result);
      try { onCycle(result); } catch (error) { status.error(error); }
    },
    onError(error, context) {
      status.error(error);
      try { onError(error, context); } catch {}
    },
    acquireInstanceLock: () => acquireInstanceLock(config.instanceLockPath),
  });

  return Object.freeze({
    service,
    inbox,
    status,
    getStatus() { return status.snapshot({ running: service.running }); },
  });
}
