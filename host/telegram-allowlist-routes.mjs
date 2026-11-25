/**
 * Telegram allowlist HTTP handlers for the local API.
 * @param {{ getTelegramAllowlist: Function|null, setTelegramAllowlist: Function|null, readJson: Function, send: Function }} deps
 */
export async function handleTelegramAllowlistRoutes({ request, response, pathname, getTelegramAllowlist, setTelegramAllowlist, readJson, send }) {
  if (request.method === 'GET' && pathname === '/api/telegram/allowlist') {
    if (typeof getTelegramAllowlist !== 'function') {
      send(response, 503, { error: 'Белый список Telegram недоступен на этом хосте.' });
      return true;
    }
    try {
      const result = await getTelegramAllowlist();
      send(response, 200, { users: Array.isArray(result?.users) ? result.users : [] });
    } catch (error) {
      send(response, 500, { error: error?.message || 'Не удалось прочитать белый список.' });
    }
    return true;
  }
  if (request.method === 'POST' && pathname === '/api/telegram/allowlist') {
    if (typeof setTelegramAllowlist !== 'function') {
      send(response, 503, { error: 'Изменение белого списка Telegram недоступно на этом хосте.' });
      return true;
    }
    const contentType = String(request.headers['content-type'] || '').trim().toLowerCase();
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/.test(contentType)) {
      send(response, 415, { error: 'Ожидается Content-Type: application/json.' });
      request.resume();
      return true;
    }
    try {
      const body = await readJson(request, 32_768);
      if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.users)) {
        send(response, 400, { error: 'Ожидается объект { users: [{ id, comment }] }.' });
        return true;
      }
      if (body.users.length < 1 || body.users.length > 100) {
        send(response, 400, { error: 'Белый список должен содержать от 1 до 100 пользователей.' });
        return true;
      }
      for (const row of body.users) {
        if (!row || typeof row !== 'object' || typeof row.id !== 'string' || !/^[1-9]\d{0,15}$/.test(row.id)) {
          send(response, 400, { error: 'Каждый пользователь должен иметь положительный числовой Telegram ID.' });
          return true;
        }
        if (row.comment != null && (typeof row.comment !== 'string' || row.comment.length > 120)) {
          send(response, 400, { error: 'Комментарий не длиннее 120 символов.' });
          return true;
        }
      }
      const result = await setTelegramAllowlist(body.users);
      send(response, 200, { ok: true, users: result?.users || body.users });
    } catch (error) {
      send(response, 400, {
        error: typeof error?.message === 'string' && error.message.length <= 200
          ? error.message : 'Не удалось сохранить белый список.',
        code: typeof error?.code === 'string' ? error.code : 'TELEGRAM_ALLOWLIST_FAILED',
      });
    }
    return true;
  }
  return false;
}
