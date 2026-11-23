const BINARY_MARKER = '__buildbookBinaryV1';

function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function setOwnDataProperty(target, key, value) {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    writable: true,
    value,
  });
}

function isBinaryDescriptor(value) {
  return isPlainObject(value)
    && value[BINARY_MARKER] === true
    && value.encoding === 'base64'
    && typeof value.data === 'string';
}

function encode(value) {
  if (value instanceof ArrayBuffer) {
    return { [BINARY_MARKER]: true, encoding: 'base64', data: bytesToBase64(new Uint8Array(value)) };
  }
  if (ArrayBuffer.isView(value)) {
    return { [BINARY_MARKER]: true, encoding: 'base64', data: bytesToBase64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) };
  }
  if (Array.isArray(value)) return value.map(encode);
  if (isPlainObject(value)) {
    // Escape ordinary data that collides with either reserved transport tag.
    if (value[BINARY_MARKER] === true && (value.encoding === 'base64' && typeof value.data === 'string' || value.encoding === 'escaped-object')) {
      return {
        [BINARY_MARKER]: true,
        encoding: 'escaped-object',
        entries: Object.entries(value).map(([key, item]) => [key, encode(item)]),
      };
    }
    const result = {};
    for (const [key, item] of Object.entries(value)) setOwnDataProperty(result, key, encode(item));
    return result;
  }
  return value;
}

function decode(value) {
  if (Array.isArray(value)) return value.map(decode);
  if (isPlainObject(value)) {
    if (isBinaryDescriptor(value)) {
      const bytes = base64ToBytes(value.data);
      if (bytesToBase64(bytes) !== value.data) throw new Error('Канонический профиль содержит некорректный бинарный дескриптор.');
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
    if (value[BINARY_MARKER] === true && value.encoding === 'escaped-object') {
      if (!Array.isArray(value.entries)
        || value.entries.some(entry => !Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string')) {
        throw new Error('Канонический профиль содержит некорректный экранированный объект.');
      }
      const keys = new Set();
      for (const [key] of value.entries) {
        if (keys.has(key)) throw new Error('Канонический профиль содержит повторяющийся ключ экранированного объекта.');
        keys.add(key);
      }
      const result = {};
      for (const [key, item] of value.entries) setOwnDataProperty(result, key, decode(item));
      return result;
    }
    const result = {};
    for (const [key, item] of Object.entries(value)) setOwnDataProperty(result, key, decode(item));
    return result;
  }
  return value;
}

/**
 * Adapt the canonical local API to the existing repository contract.
 * IndexedDB remains the app's default; callers must opt in only after secure
 * token bootstrap and same-origin hosting have been configured.
 */
export function createProfileRepositoryAdapter(client) {
  if (!client || typeof client.readProfile !== 'function' || typeof client.writeProfile !== 'function') {
    throw new Error('Нужен клиент локального профильного API.');
  }

  return Object.freeze({
    async readProfile() {
      const result = await client.readProfile();
      const profile = result.profile;
      if (profile === null) return { state: undefined, logs: undefined, photos: undefined, revision: result.revision };
      if (!isPlainObject(profile)) throw new Error('Канонический профиль имеет неверный формат.');
      return {
        state: decode(profile.state),
        logs: decode(profile.logs),
        photos: decode(profile.photos),
        revision: result.revision,
      };
    },
    async writeProfile(state, logs, photos, expectedRevision) {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
        throw new TypeError('Для сохранения профиля нужна корректная ревизия.');
      }
      // Preserve host-owned metadata (including the Telegram idempotency ledger)
      // when the UI saves its own state. Never merge across a stale revision:
      // that would overwrite a concurrent finance operation.
      const current = await client.readProfile();
      if (current.revision !== expectedRevision) {
        const error = new Error('Профиль уже изменён другим клиентом. Обновите данные и повторите сохранение.');
        error.name = 'BuildbookStorageConflictError';
        error.code = 'BUILD_BOOK_STORAGE_CONFLICT';
        error.expectedRevision = expectedRevision;
        error.currentRevision = current.revision;
        throw error;
      }
      const base = current.profile === null ? {} : decode(current.profile);
      if (!isPlainObject(base)) throw new Error('Канонический профиль имеет неверный формат.');
      const profile = encode({ ...base, state, logs, photos });
      return client.writeProfile(profile, expectedRevision);
    },
    async close() {},
  });
}
