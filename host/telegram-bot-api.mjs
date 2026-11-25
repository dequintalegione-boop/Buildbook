import { readBoundedTelegramJson } from './telegram-response.mjs';

const TOKEN_PATTERN = /^(\d{1,16}):([A-Za-z0-9_-]{20,})$/;

function safeBotProfile(result) {
  if (!result || result.is_bot !== true || !Number.isSafeInteger(result.id) || result.id <= 0
    || typeof result.first_name !== 'string' || result.first_name.length > 256
    || (result.username !== undefined && (typeof result.username !== 'string' || result.username.length > 64))) {
    throw new Error('Telegram returned an invalid bot profile.');
  }
  return Object.freeze({
    id: String(result.id),
    firstName: result.first_name,
    username: result.username || null,
    canJoinGroups: result.can_join_groups === true,
    canReadAllGroupMessages: result.can_read_all_group_messages === true,
    supportsInlineQueries: result.supports_inline_queries === true,
  });
}

export function createTelegramBotApi({ fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required.');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30_000) {
    throw new TypeError('Telegram Bot API timeout must be between 1000 and 30000 milliseconds.');
  }

  async function call(token, method, payload = null) {
    if (typeof token !== 'string' || token.length > 256 || !TOKEN_PATTERN.test(token)) {
      const error = new Error('Проверьте формат токена Telegram Bot API.');
      error.code = 'TELEGRAM_TOKEN_FORMAT';
      throw error;
    }
    if (!['getMe', 'getMyCommands', 'setMyCommands'].includes(method)) {
      throw new TypeError('Unsupported Telegram Bot API method.');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl('https://api.telegram.org/bot' + token + '/' + method, {
        method: payload ? 'POST' : 'GET',
        headers: payload ? { 'content-type': 'application/json' } : undefined,
        body: payload ? JSON.stringify(payload) : undefined,
        signal: controller.signal,
        redirect: 'error',
      });
      const body = await readBoundedTelegramJson(response);
      if (!response?.ok || body?.ok !== true) {
        const error = new Error(body?.error_code === 401
          ? 'Telegram не принял токен. Проверьте его в BotFather.'
          : 'Telegram Bot API отклонил запрос.');
        error.code = body?.error_code === 401 ? 'TELEGRAM_TOKEN_REJECTED' : 'TELEGRAM_BOT_API_ERROR';
        throw error;
      }
      return body.result;
    } catch (cause) {
      if (cause?.code === 'TELEGRAM_TOKEN_REJECTED' || cause?.code === 'TELEGRAM_BOT_API_ERROR') throw cause;
      if (controller.signal.aborted) {
        const error = new Error('Telegram Bot API не ответил за отведённое время.');
        error.code = 'TELEGRAM_BOT_API_TIMEOUT';
        throw error;
      }
      const error = new Error('Не удалось связаться с Telegram Bot API.');
      error.code = 'TELEGRAM_BOT_API_UNAVAILABLE';
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  return Object.freeze({
    async getMe(token) {
      return safeBotProfile(await call(token, 'getMe'));
    },
    async getMyCommands(token) {
      const commands = await call(token, 'getMyCommands');
      if (!Array.isArray(commands) || commands.length > 100) throw new Error('Telegram returned an invalid command list.');
      return commands.map(command => ({
        command: String(command.command || ''),
        description: String(command.description || ''),
      }));
    },
    async setMyCommands(token, commands) {
      if (!Array.isArray(commands) || commands.length > 100) throw new TypeError('A list of at most 100 commands is required.');
      const normalized = commands.map(item => {
        const command = String(item?.command || '').trim().replace(/^\//, '');
        const description = String(item?.description || '').trim();
        if (!/^[a-z0-9_]{1,32}$/.test(command) || !description || description.length > 256
          || /[\u0000-\u001f\u007f]/.test(description)) {
          throw new TypeError('Команда должна содержать 1–32 латинских символа, цифр или _, описание — до 256 символов.');
        }
        return { command, description };
      });
      if (new Set(normalized.map(item => item.command)).size !== normalized.length) {
        throw new TypeError('Команды не должны повторяться.');
      }
      return call(token, 'setMyCommands', { commands: normalized });
    },
  });
}
