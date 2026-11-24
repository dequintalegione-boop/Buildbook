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
  // from leaking into the canonical profile.
  const snapshot = {
    state: sourceProfile.state,
    logs: sourceProfile.logs,
    photos: sourceProfile.photos,
  };
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

  const envelope = await createEnvelope(snapshot);
  if (!isPlainObject(envelope) || !isPlainObject(envelope.payload)
    || !isPlainObject(envelope.payload.state) || !Array.isArray(envelope.payload.logs)
    || !isPlainObject(envelope.payload.photos)) {
    throw new Error('Генератор переноса вернул некорректный конверт; исходная база не изменена.');
  }
  const expectedPayload = JSON.stringify(snapshot);
  if (JSON.stringify(envelope.payload) !== expectedPayload) {
    throw new Error('Конверт переноса не совпадает с исходным снимком; импорт отменён.');
  }

  const revision = await client.importProfile(envelope, target.revision);
  const verified = await client.readProfile();
  if (!verified || verified.revision !== revision || !isPlainObject(verified.profile)
    || JSON.stringify(verified.profile) !== expectedPayload) {
    const error = new Error('Импорт выполнен, но контрольное чтение не подтвердило точное совпадение профиля. Исходная база сохранена; не переключайте хранилище.');
    error.code = 'BUILD_BOOK_MIGRATION_VERIFY_FAILED';
    throw error;
  }

  return Object.freeze({ migrated: true, revision, verified: true });
}
