/**
 * Host-side runtime overrides for Telegram settings that the UI may change
 * without editing .env (allowlist with optional comments, command toggles).
 */
import { open, mkdir, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

const SCHEMA = 2;
const MAX_BYTES = 64 * 1024;

const DEFAULT_COMMANDS = Object.freeze({
  income: true,
  expense: true,
  stats: true,
  help: true,
});

function normalizeUserId(raw) {
  const s = String(raw ?? '').trim();
  if (!/^\d{1,16}$/.test(s) || !Number.isSafeInteger(Number(s)) || Number(s) <= 0 || String(Number(s)) !== s) {
    throw new TypeError('Invalid Telegram user ID in allowlist');
  }
  return s;
}

function normalizeComment(raw) {
  if (raw == null) return '';
  const s = String(raw).replace(/[\r\n\0]/g, ' ').trim();
  return s.slice(0, 120);
}

/**
 * Accepts string[] of IDs or {id, comment}[] objects.
 * @returns {{ id: string, comment: string }[]}
 */
export function normalizeAllowlistEntries(ids) {
  if (!Array.isArray(ids)) throw new TypeError('allowlist must be an array');
  if (ids.length > 100) throw new TypeError('allowlist cannot exceed 100 entries');
  const result = [];
  const seen = new Set();
  for (const raw of ids) {
    let id;
    let comment = '';
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      id = normalizeUserId(raw.id ?? raw.userId);
      comment = normalizeComment(raw.comment ?? raw.note ?? '');
    } else {
      id = normalizeUserId(raw);
    }
    if (seen.has(id)) continue;
    seen.add(id);
    result.push({ id, comment });
  }
  return result;
}

function normalizeCommands(input) {
  const out = { ...DEFAULT_COMMANDS };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const key of Object.keys(DEFAULT_COMMANDS)) {
    if (typeof input[key] === 'boolean') out[key] = input[key];
  }
  return out;
}

function emptyState(seedAllowlist = []) {
  return {
    schema: SCHEMA,
    allowlist: normalizeAllowlistEntries(seedAllowlist),
    commands: { ...DEFAULT_COMMANDS },
    updatedAt: null,
  };
}

/**
 * @param {string} filePath absolute path for runtime config JSON
 * @param {{ allowlist?: string[] }} [seed] initial values from .env when file is empty
 */
export function createTelegramRuntimeConfig(filePath, seed = {}) {
  if (!filePath || typeof filePath !== 'string' || !isAbsolute(filePath)) {
    throw new TypeError('Runtime config path must be absolute');
  }
  const path = resolve(filePath);
  let state = emptyState(seed.allowlist || []);
  let loaded = false;
  let writeChain = Promise.resolve();

  async function load() {
    if (loaded) return state;
    try {
      const handle = await open(path, 'r');
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('invalid');
        const buf = Buffer.alloc(stat.size);
        await handle.read(buf, 0, stat.size, 0);
        const parsed = JSON.parse(buf.toString('utf8'));
        if (!parsed || typeof parsed !== 'object') throw new Error('invalid');
        const rawList = Array.isArray(parsed.allowlist) ? parsed.allowlist : seed.allowlist || [];
        state = {
          schema: SCHEMA,
          allowlist: normalizeAllowlistEntries(rawList),
          commands: normalizeCommands(parsed.commands),
          updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
        };
      } finally {
        await handle.close();
      }
    } catch {
      state = emptyState(seed.allowlist || []);
    }
    loaded = true;
    return state;
  }

  async function persist(next) {
    await mkdir(dirname(path), { recursive: true });
    const tmp = path + '.tmp-' + process.pid;
    const payload = JSON.stringify(next, null, 2);
    const handle = await open(tmp, 'w', 0o600);
    try {
      await handle.writeFile(payload, 'utf8');
      await handle.sync();
    } finally {
      await handle.close().catch(() => {});
    }
    await rename(tmp, path);
    try { await rm(tmp, { force: true }); } catch {}
  }

  function enqueue(fn) {
    const run = writeChain.then(fn, fn);
    writeChain = run.then(() => {}, () => {});
    return run;
  }

  return {
    /** @deprecated use getSummary — kept for host service compatibility */
    async read() {
      return this.getSummary();
    },
    async getAllowlist() {
      await load();
      return state.allowlist.map((e) => e.id);
    },
    async getAllowlistEntries() {
      await load();
      return state.allowlist.map((e) => ({ id: e.id, comment: e.comment }));
    },
    async getCommands() {
      await load();
      return { ...state.commands };
    },
    async getSummary() {
      await load();
      return {
        allowlist: state.allowlist.map((e) => e.id),
        allowlistEntries: state.allowlist.map((e) => ({ id: e.id, comment: e.comment })),
        commands: { ...state.commands },
        updatedAt: state.updatedAt,
      };
    },
    async setAllowlist(ids) {
      return enqueue(async () => {
        await load();
        state = {
          ...state,
          allowlist: normalizeAllowlistEntries(ids),
          updatedAt: new Date().toISOString(),
        };
        await persist(state);
        return {
          allowlist: state.allowlist.map((e) => e.id),
          allowlistEntries: state.allowlist.map((e) => ({ id: e.id, comment: e.comment })),
          updatedAt: state.updatedAt,
        };
      });
    },
    async setCommands(partial) {
      return enqueue(async () => {
        await load();
        state = {
          ...state,
          commands: normalizeCommands({ ...state.commands, ...partial }),
          updatedAt: new Date().toISOString(),
        };
        await persist(state);
        return { commands: { ...state.commands }, updatedAt: state.updatedAt };
      });
    },
  };
}
