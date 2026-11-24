import { createInboxStore } from './inbox-store.mjs';
import { createTelegramOffsetStore } from './telegram-offset-store.mjs';
import { createTelegramUpdateGate } from './telegram-update-gate.mjs';
import { createTelegramPoller } from './telegram-poller.mjs';
import { createTelegramInboxProcessor } from './telegram-inbox-processor.mjs';
import { createTelegramRuntime } from './telegram-runtime.mjs';
import { createTelegramService } from './telegram-service.mjs';
import { acquireInstanceLock } from './instance-lock.mjs';
import { createTelegramStatus } from './telegram-status.mjs';
import { buildTelegramFinanceTransactionFromUpdate } from './telegram-finance-command.mjs';
import { createTelegramCommandAdapter } from './telegram-command-adapter.mjs';
import { createTelegramReplySender } from './telegram-reply.mjs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * Compose the Telegram host from validated host-only configuration and a
 * canonical Buildbook write boundary. profileStore must be the same profile
 * store used by the UI; passing a separate profile would create a second ledger.
 * The injected applyUpdate path remains available for an existing domain adapter.
 */
export function createTelegramHostService({
  config,
  applyUpdate,
  profileStore,
  buildTransaction,
  fetchImpl = globalThis.fetch,
  onCycle = () => {},
  onError = () => {},
} = {}) {
  if (!config || typeof config !== 'object') throw new TypeError('Validated Telegram host config is required.');
  const hasInjectedAdapter = typeof applyUpdate === 'function';
  const hasProfileAdapter = Boolean(profileStore);
  if (hasInjectedAdapter === hasProfileAdapter) {
    throw new TypeError('Provide exactly one of applyUpdate or profileStore.');
  }
  if (buildTransaction !== undefined && typeof buildTransaction !== 'function') {
    throw new TypeError('buildTransaction must be a function when supplied.');
  }
  if (hasProfileAdapter && (typeof profileStore.read !== 'function' || typeof profileStore.write !== 'function')) {
    throw new TypeError('profileStore must expose read() and write() methods.');
  }
  const canonicalApplyUpdate = hasInjectedAdapter
    ? applyUpdate
    : createTelegramCommandAdapter({
      profileStore,
      buildTransaction: buildTransaction || ((update, options) => buildTelegramFinanceTransactionFromUpdate(update, {
        ...options,
        defaults: { accountId: config.defaultAccountId || null },
      })),
    });
  if (typeof config.botToken !== 'string' || !config.botToken
    || typeof config.botId !== 'string' || !config.botId
    || !Array.isArray(config.allowedUserIds)
    || typeof config.inboxPath !== 'string'
    || typeof config.offsetPath !== 'string'
    || typeof config.instanceLockPath !== 'string') {
    throw new TypeError('Telegram host config is incomplete.');
  }

  // The bot ID is used to namespace durable update keys. Reject a hand-built
  // config that pairs one bot's token with another bot's ID; otherwise updates
  // could be recorded under the wrong identity and collide with another bot.
  const tokenIdentity = /^(\d+):([A-Za-z0-9_-]+)$/.exec(config.botToken);
  if (!tokenIdentity || config.botToken.length > 256 || tokenIdentity[1].length > 16
    || !Number.isSafeInteger(Number(tokenIdentity[1])) || Number(tokenIdentity[1]) <= 0
    || String(Number(tokenIdentity[1])) !== tokenIdentity[1] || tokenIdentity[1] !== config.botId) {
    throw new TypeError('Telegram bot ID must match the bot token identity.');
  }

  if (config.allowedUserIds.length < 1 || config.allowedUserIds.length > 100) {
    throw new TypeError('Telegram host allowlist must contain 1–100 user IDs.');
  }
  const paths = [config.inboxPath, config.offsetPath, config.instanceLockPath];
  if (paths.some(path => !isAbsolute(path))) throw new TypeError('Telegram host data paths must be absolute.');
  const normalizedPaths = paths.map(path => resolve(path))
    .map(path => process.platform === 'win32' ? path.toLowerCase() : path);
  const pathsOverlap = (left, right) => {
    const rel = relative(left, right);
    return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
  };
  if (normalizedPaths.some((path, index) => normalizedPaths.some((other, otherIndex) =>
    index !== otherIndex && pathsOverlap(path, other)))) {
    throw new TypeError('Telegram host data paths must not overlap.');
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
  const processor = createTelegramInboxProcessor({
    inbox,
    applyUpdate: canonicalApplyUpdate,
    deliverReply: createTelegramReplySender({ botToken: config.botToken, fetchImpl }),
  });
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
