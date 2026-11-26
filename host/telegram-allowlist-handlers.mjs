import { dirname, resolve } from 'node:path';
import { readAllowlistMeta, writeAllowlistMeta } from './telegram-allowlist-meta.mjs';
import { updateTelegramEnvFile } from './telegram-env-store.mjs';

/**
 * Build allowlist get/set handlers bound to the running host composition.
 */
export function createTelegramAllowlistHandlers({ env, appRoot, getTelegram }) {
  const metaPath = resolve(dirname(resolve(env.BUILDBOOK_PROFILE_PATH || resolve(appRoot, 'data/profile.json'))), 'telegram-allowlist-meta.json');
  return {
    getTelegramAllowlist: async () => {
      const telegram = getTelegram();
      const envIds = String(env.BUILDBOOK_TELEGRAM_ALLOWED_USER_IDS || '')
        .split(/[\\s,]+/).map(s => s.trim()).filter(Boolean);
      const liveIds = telegram && typeof telegram.getAllowlist === 'function'
        ? telegram.getAllowlist().map(String)
        : envIds;
      const activeIds = new Set(liveIds);
      const meta = await readAllowlistMeta(metaPath);
      const usersById = new Map(meta.users.map(user => [user.id, {
        ...user,
        // The live gate is authoritative: a row is active only if its ID is
        // actually present in the service allowlist loaded from .env.
        active: activeIds.has(user.id),
      }]));
      for (const id of liveIds) {
        const key = String(id);
        if (!usersById.has(key)) usersById.set(key, { id: key, comment: '', active: true, addedAt: null });
      }
      return { users: [...usersById.values()] };
    },
    setTelegramAllowlist: async (users) => {
      if (!Array.isArray(users) || users.length < 1 || users.length > 100) {
        throw new TypeError('Белый список должен содержать от 1 до 100 пользователей.');
      }
      const activeIds = users.filter(user => user.active !== false).map(user => String(user.id));
      const uniqueActiveIds = [...new Set(activeIds)];
      if (!uniqueActiveIds.length) throw new Error('Оставьте хотя бы одного активного пользователя в белом списке.');
      const uniqueIds = new Set(users.map(user => String(user.id)));
      if (uniqueIds.size !== users.length) throw new Error('В белом списке не должно быть повторяющихся Telegram ID.');

      // Persist metadata first. If writing .env fails, the live gate is not
      // changed and the metadata remains safely editable on the next attempt.
      const saved = await writeAllowlistMeta(metaPath, users.map(user => ({
        id: String(user.id),
        comment: user.comment || '',
        active: user.active !== false,
        addedAt: user.addedAt,
      })));
      await updateTelegramEnvFile({
        envFile: resolve(appRoot, '.env'),
        values: { BUILDBOOK_TELEGRAM_ALLOWED_USER_IDS: uniqueActiveIds.join(',') },
      });
      env.BUILDBOOK_TELEGRAM_ALLOWED_USER_IDS = uniqueActiveIds.join(',');
      const telegram = getTelegram();
      if (telegram && typeof telegram.setAllowlist === 'function') telegram.setAllowlist(uniqueActiveIds);
      return saved;
    },
  };
}
