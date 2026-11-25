(function registerProfileExport(global) {
  'use strict';

  const FORMAT = 'buildbook-profile-export';
  const VERSION = 1;
  const SOURCE_SCHEMA_VERSION = 5;
  const MAX_PROFILE_BYTES = 32 * 1024 * 1024;

  const ISO_EXPORT_DATE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/;

  function isValidExportDate(value) {
    if (typeof value !== 'string') return false;
    const match = ISO_EXPORT_DATE.exec(value);
    if (!match) return false;
    const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = '', zone, sign, offsetHourText, offsetMinuteText] = match;
    const year = Number(yearText), month = Number(monthText), day = Number(dayText);
    const hour = Number(hourText), minute = Number(minuteText), second = Number(secondText);
    const offsetHour = Number(offsetHourText || 0), offsetMinute = Number(offsetMinuteText || 0);
    if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59
      || offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) return false;
    const date = new Date(0);
    date.setUTCFullYear(year, month - 1, day);
    date.setUTCHours(hour, minute, second, Number((fraction + '000').slice(0, 3)));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day
      || date.getUTCHours() !== hour || date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second) return false;
    return Number.isFinite(Date.parse(value)) && (sign === '+' || sign === '-' || zone === 'Z');
  }

  function requireRecord(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError(label + ' должен быть объектом.');
    }
  }

  function copyPayload(profile) {
    requireRecord(profile, 'Профиль');
    requireRecord(profile.state, 'Состояние профиля');
    if (!Array.isArray(profile.logs)) throw new TypeError('Журнал профиля должен быть массивом.');
    requireRecord(profile.photos, 'Фотографии профиля');
    // Explicit allowlist: host metadata, Telegram inbox/idempotency state, and credentials
    // are never copied into the user-facing backup.
    return {
      state: profile.state,
      logs: profile.logs,
      photos: profile.photos,
    };
  }

  async function createEnvelope(profile, exportedAt = new Date().toISOString()) {
    if (!isValidExportDate(exportedAt)) {
      throw new TypeError('Некорректная дата экспорта.');
    }
    if (!global.crypto || !global.crypto.subtle || typeof TextEncoder !== 'function') {
      throw new Error('В этой среде недоступна безопасная контрольная сумма SHA-256.');
    }
    const payload = copyPayload(profile);
    let serialized;
    try {
      serialized = JSON.stringify(payload);
    } catch (_) {
      throw new TypeError('Профиль должен содержать только сериализуемые JSON-данные.');
    }
    if (typeof serialized !== 'string') {
      throw new TypeError('Профиль не удалось преобразовать в JSON.');
    }
    const bytes = new TextEncoder().encode(serialized);
    if (bytes.byteLength > MAX_PROFILE_BYTES) {
      throw new RangeError('Размер профиля превышает допустимые 32 MiB.');
    }
    const digest = await global.crypto.subtle.digest('SHA-256', bytes);
    const sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    return {
      format: FORMAT,
      version: VERSION,
      sourceSchemaVersion: SOURCE_SCHEMA_VERSION,
      exportedAt,
      payload,
      sha256,
    };
  }

  async function serialize(profile, exportedAt) {
    return JSON.stringify(await createEnvelope(profile, exportedAt), null, 2);
  }

  global.BuildbookProfileExport = Object.freeze({ createEnvelope, serialize });
})(window);
