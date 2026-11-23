(function registerProfileImport(global) {
  'use strict';

  const FORMAT = 'buildbook-profile-export';
  const VERSION = 1;
  const SOURCE_SCHEMA_VERSION = 5;
  const MAX_PROFILE_BYTES = 32 * 1024 * 1024;
  const MAX_FILE_BYTES = 34 * 1024 * 1024;
  const ISO_EXPORT_DATE = /^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?(?:Z|[+-]\\d{2}:\\d{2})$/;
  const HEX_SHA256 = /^[a-f0-9]{64}$/;

  function record(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError(label + ' должен быть объектом.');
    }
  }

  function equalDigest(left, right) {
    if (left.length !== right.length) return false;
    let mismatch = 0;
    for (let i = 0; i < left.length; i += 1) mismatch |= left.charCodeAt(i) ^ right.charCodeAt(i);
    return mismatch === 0;
  }

  async function validateEnvelope(input) {
    record(input, 'Файл импорта');
    if (input.format !== FORMAT || input.version !== VERSION) {
      throw new Error('Формат или версия файла импорта не поддерживается.');
    }
    if (input.sourceSchemaVersion !== SOURCE_SCHEMA_VERSION) {
      throw new Error('Версия схемы профиля в файле не поддерживается.');
    }
    if (typeof input.exportedAt !== 'string' || !ISO_EXPORT_DATE.test(input.exportedAt) || !Number.isFinite(Date.parse(input.exportedAt))) {
      throw new Error('В файле указана некорректная дата экспорта.');
    }
    if (typeof input.sha256 !== 'string' || !HEX_SHA256.test(input.sha256)) {
      throw new Error('Контрольная сумма файла имеет неверный формат.');
    }
    const envelopeKeys = ['format', 'version', 'sourceSchemaVersion', 'exportedAt', 'payload', 'sha256'];
    if (Object.keys(input).some(key => !envelopeKeys.includes(key))) {
      throw new Error('Файл содержит неизвестные поля конверта.');
    }
    record(input.payload, 'Данные профиля');
    const payloadKeys = ['state', 'logs', 'photos'];
    if (Object.keys(input.payload).some(key => !payloadKeys.includes(key))) {
      throw new Error('Данные профиля содержат неподдерживаемые поля.');
    }
    record(input.payload.state, 'Состояние профиля');
    if (!Array.isArray(input.payload.logs)) throw new TypeError('Журнал профиля должен быть массивом.');
    record(input.payload.photos, 'Фотографии профиля');

    if (!global.crypto || !global.crypto.subtle || typeof TextEncoder !== 'function') {
      throw new Error('В этой среде недоступна проверка SHA-256.');
    }
    let serialized;
    try {
      serialized = JSON.stringify(input.payload);
    } catch (_) {
      throw new TypeError('Данные профиля должны быть сериализуемыми JSON-данными.');
    }
    if (typeof serialized !== 'string') throw new TypeError('Не удалось прочитать данные профиля.');
    const bytes = new TextEncoder().encode(serialized);
    if (bytes.byteLength > MAX_PROFILE_BYTES) {
      throw new RangeError('Размер профиля превышает допустимые 32 MiB.');
    }
    const digest = await global.crypto.subtle.digest('SHA-256', bytes);
    const actual = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    if (!equalDigest(actual, input.sha256)) {
      throw new Error('Контрольная сумма не совпадает: файл повреждён или изменён.');
    }

    return Object.freeze({
      format: FORMAT,
      version: VERSION,
      sourceSchemaVersion: SOURCE_SCHEMA_VERSION,
      exportedAt: input.exportedAt,
      payload: input.payload,
      sha256: input.sha256,
      sizeBytes: bytes.byteLength,
    });
  }

  async function parseAndValidate(text) {
    if (typeof text !== 'string') throw new TypeError('Содержимое файла должно быть текстом.');
    // Reject oversized input before JSON.parse allocates the object graph.
    if (text.length > MAX_FILE_BYTES) throw new RangeError('Размер файла превышает допустимые 34 MiB.');
    if (typeof TextEncoder !== 'function' || new TextEncoder().encode(text).byteLength > MAX_FILE_BYTES) {
      throw new RangeError('Размер файла превышает допустимые 34 MiB.');
    }
    let parsed;
    try { parsed = JSON.parse(text); } catch (_) {
      throw new Error('Файл импорта не содержит корректный JSON.');
    }
    return validateEnvelope(parsed);
  }

  global.BuildbookProfileImport = Object.freeze({ validateEnvelope, parseAndValidate });
})(window);
