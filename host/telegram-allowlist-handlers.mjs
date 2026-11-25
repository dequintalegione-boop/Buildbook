import { dirname, resolve } from 'node:path';
import { readAllowlistMeta, writeAllowlistMeta } from './telegram-allowlist-meta.mjs';
import { updateTelegramEnvFile } from './telegram-env-store.mjs';

/**
 * Build allowlist get/set handlers bound to the running host composition.
 */
export function createTelegramAllowlistHandlers({ env, appRoot, getTelegram }) {
  return {
    getTelegramAllowlist: async () => {
      const telegram = getTelegram();
      const envIds = String(env.BUILDBOOK_TELEGRAM_ALLOWED_USER_IDS || '')
        .split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
      const liveIds = telegram && typeof telegram.getAllowlist === 'function'
        ? telegram.getAllowlist()
        : envIds;
      const metaPath = resolve(dirname(resolve(env.BUILDBOOK_PROFILE_PATH || resolve(appRoot, 'data/profile.json'))), 'telegram-allowlist-meta.json');
      const meta = await readAllowlistMeta(metaPath);
      const commentById = new Map(meta.users.map(u => [u.id, u.comment]));
      const users = liveIds.map(id => ({ id: String(id), comment: commentById.get(String(id)) || '' }));
      return { users };
    },
    setTelegramAllowlist: async (users) => {
      const telegram = getTelegram();
      const ids = users.map(u => String(u.id));
      const unique = [...new Set(ids)];
      if (!unique.length) throw new Error('Нужен хотя бы один пользователь в белом списке.');
      await updateTelegramEnvFile({
        envFile: resolve(appRoot, '.env'),
        values: { BUILDBOOK_TELEGRAM_ALLOWED_USER_IDS: unique.join(',') },
      });
      env.BUILDBOOK_TELEGRAM_ALLOWED_USER_IDS = unique.join(',');
      if (telegram && typeof telegram.setAllowlist === 'function') {
        telegram.setAllowlist(unique);
      }
      const metaPath = resolve(dirname(resolve(env.BUILDBOOK_PROFILE_PATH || resolve(appRoot, 'data/profile.json'))), 'telegram-allowlist-meta.json');
      return writeAllowlistMeta(metaPath, users.map(u => ({ id: String(u.id), comment: u.comment || '' })));
    },
  };
}
