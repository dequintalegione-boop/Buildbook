function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Copy the current IndexedDB snapshot into an empty canonical local profile.
 * This deliberately never clears or mutates the source repository: the caller
 * may switch back only after the imported profile has been read and verified.
 */
export async function migrateProfileToLocalApi({ client, sourceProfile, createEnvelope } = {}) {
  if (!client || typeof client.readProfile !== 'function' || typeof client.importProfile !== 'function') {
    throw new TypeError('Для переноса нужен клиент канонического профильного API.');
  }
  if (typeof createEnvelope !== 'function') {
    throw new TypeError('Для переноса нужен проверенный генератор конверта резервной копии.');
  }
  if (!isPlainObject(sourceProfile)
    || !isPlainObject(sourceProfile.state)
    || !Array.isArray(sourceProfile.logs)
    || !isPlainObject(sourceProfile.photos)) {
    throw new TypeError('Исходный профиль имеет неподдерживаемый формат; исходные данные не изменены.');
  }

  // Explicit allowlist prevents IndexedDB bookkeeping or host-owned metadata
  // from leaking into the canonical profile. Detach the migration snapshot from
  // IndexedDB objects before the first await: the UI may continue editing them
  // while the envelope is being hashed or the API request is in flight.
  let serializedSnapshot;
  try {
    serializedSnapshot = JSON.stringify({
      state: sourceProfile.state,
      logs: sourceProfile.logs,
      photos: sourceProfile.photos,
    });
  } catch {
    throw new TypeError('Исходный профиль содержит данные, которые нельзя безопасно перенести в JSON.');
  }
  if (typeof serializedSnapshot !== 'string') {
    throw new TypeError('Исходный профиль не удалось безопасно сериализовать.');
  }
  const snapshot = JSON.parse(serializedSnapshot);
  const freezeDeep = value => {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    for (const child of Object.values(value)) freezeDeep(child);
    return Object.freeze(value);
  };
  freezeDeep(snapshot);
  const target = await client.readProfile();
  if (!target || !Number.isSafeInteger(target.revision) || target.revision < 0
    || !(target.profile === null || isPlainObject(target.profile))) {
    throw new Error('Канонический профильный API вернул некорректное состояние.');
  }
  if (target.profile !== null) {
    const error = new Error('Целевой профиль уже содержит данные. Автоматический перенос остановлен; исходная база не изменена.');
    error.code = 'BUILD_BOOK_MIGRATION_TARGET_NOT_EMPTY';
    error.currentRevision = target.revision;
    throw error;
  }
  if (target.revision === Number.MAX_SAFE_INTEGER) {
    throw new RangeError('Исчерпан диапазон ревизий канонического профиля; перенос остановлен.');
  }

  const envelope = await createEnvelope(snapshot);
  if (!isPlainObject(envelope)
    || envelope.format !== 'buildbook-profile-export'
    || envelope.version !== 1
    || envelope.sourceSchemaVersion !== 5
    || typeof envelope.exportedAt !== 'string'
    || !Number.isFinite(Date.parse(envelope.exportedAt))
    || typeof envelope.sha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(envelope.sha256)
    || !isPlainObject(envelope.payload)
    || !isPlainObject(envelope.payload.state)
    || !Array.isArray(envelope.payload.logs)
    || !isPlainObject(envelope.payload.photos)) {
    throw new Error('Генератор переноса вернул некорректный конверт; исходная база не изменена.');
  }
  const expectedPayload = JSON.stringify(snapshot);
  let actualPayload;
  try { actualPayload = JSON.stringify(envelope.payload); } catch {
    throw new Error('Конверт переноса содержит несериализуемые данные; импорт отменён.');
  }
  if (actualPayload !== expectedPayload) {
    throw new Error('Конверт переноса не совпадает с исходным снимком; импорт отменён.');
  }

  const revision = await client.importProfile(envelope, target.revision);
  const verified = await client.readProfile();
  const expectedRevision = target.revision + 1;
  if (!Number.isSafeInteger(revision) || revision !== expectedRevision
    || !verified || verified.revision !== expectedRevision || !isPlainObject(verified.profile)
    || JSON.stringify(verified.profile) !== expectedPayload) {
    const error = new Error('Импорт выполнен, но контрольное чтение не подтвердило точное совпадение профиля. Исходная база сохранена; не переключайте хранилище.');
    error.code = 'BUILD_BOOK_MIGRATION_VERIFY_FAILED';
    throw error;
  }

  return Object.freeze({ migrated: true, revision, verified: true });
}
