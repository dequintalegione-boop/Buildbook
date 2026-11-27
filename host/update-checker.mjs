import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const OWNER = 'dequintalegione-boop';
const REPOSITORY = 'Buildbook';
const BRANCH = 'main';
const COMMIT_URL = 'https://api.github.com/repos/dequintalegione-boop/Buildbook/commits/main';
const SHA_PATTERN = /^[a-f0-9]{40}$/i;

function validateInstallMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schemaVersion !== 1
    || value.repository !== OWNER + '/' + REPOSITORY
    || value.branch !== BRANCH
    || typeof value.commit !== 'string' || !SHA_PATTERN.test(value.commit)
    || typeof value.installedAt !== 'string' || !Number.isFinite(Date.parse(value.installedAt))) {
    return null;
  }
  return Object.freeze({
    schemaVersion: 1,
    repository: OWNER + '/' + REPOSITORY,
    branch: BRANCH,
    commit: value.commit.toLowerCase(),
    installedAt: new Date(value.installedAt).toISOString(),
  });
}

async function readInstalledBuild(installRoot) {
  try {
    const raw = await readFile(join(installRoot, 'buildbook-install.json'), 'utf8');
    return validateInstallMetadata(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function createUpdateChecker({ installRoot, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  if (typeof installRoot !== 'string' || !installRoot) throw new TypeError('installRoot is required.');
  if (typeof fetchImpl !== 'function' || typeof now !== 'function') throw new TypeError('Invalid update checker dependencies.');

  return async function getUpdateStatus() {
    const installed = await readInstalledBuild(installRoot);
    let response;
    try {
      response = await fetchImpl(COMMIT_URL, {
        method: 'GET',
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'Buildbook-local-update-checker' },
        redirect: 'error',
        signal: AbortSignal.timeout(8_000),
      });
    } catch {
      const error = new Error('Не удалось связаться с GitHub. Проверьте подключение к интернету и повторите проверку.');
      error.code = 'BUILDBOOK_UPDATE_NETWORK_ERROR';
      throw error;
    }
    if (!response || !response.ok) {
      const error = new Error(response?.status === 403 || response?.status === 429
        ? 'GitHub временно ограничил запросы. Повторите проверку позже.'
        : 'GitHub не смог подтвердить последнюю версию Buildbook.');
      error.code = 'BUILDBOOK_UPDATE_SOURCE_ERROR';
      throw error;
    }

    let payload;
    try { payload = await response.json(); } catch {
      const error = new Error('GitHub вернул некорректные сведения о версии Buildbook.');
      error.code = 'BUILDBOOK_UPDATE_INVALID_RESPONSE';
      throw error;
    }
    const latestCommit = typeof payload?.sha === 'string' && SHA_PATTERN.test(payload.sha) ? payload.sha.toLowerCase() : null;
    if (!latestCommit) {
      const error = new Error('GitHub вернул некорректный идентификатор сборки.');
      error.code = 'BUILDBOOK_UPDATE_INVALID_RESPONSE';
      throw error;
    }

    const commitMessage = typeof payload?.commit?.message === 'string'
      ? payload.commit.message.split(/\r?\n/, 1)[0].slice(0, 180)
      : '';
    const committedAt = typeof payload?.commit?.committer?.date === 'string'
      && Number.isFinite(Date.parse(payload.commit.committer.date))
      ? new Date(payload.commit.committer.date).toISOString()
      : null;

    return Object.freeze({
      repository: OWNER + '/' + REPOSITORY,
      branch: BRANCH,
      checkedAt: new Date(now()).toISOString(),
      installedCommit: installed?.commit || null,
      installedAt: installed?.installedAt || null,
      latestCommit,
      latestCommittedAt: committedAt,
      latestMessage: commitMessage,
      installationTracked: !!installed,
      updateAvailable: installed ? installed.commit !== latestCommit : null,
    });
  };
}
