#!/usr/bin/env node
/**
 * One-shot: wire allowlist routes into host/local-api.mjs (idempotent).
 * Run from repo root: node scripts/apply-allowlist-local-api.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const path = resolve('host/local-api.mjs');
let text = readFileSync(path, 'utf8');
if (text.includes('handleTelegramAllowlistRoutes')) {
  console.log('local-api.mjs already wired for allowlist.');
  process.exit(0);
}
const importLine = "import { timingSafeEqual, createHash, randomBytes } from 'node:crypto';";
const importNew = importLine + "\nimport { handleTelegramAllowlistRoutes } from './telegram-allowlist-routes.mjs';";
if (!text.includes(importLine)) {
  console.error('Unexpected local-api.mjs (import not found).');
  process.exit(1);
}
text = text.replace(importLine, importNew, 1);
const oldSig = 'setTelegramCommands = null, getHostRecoveryStatus = null';
const newSig = 'setTelegramCommands = null, getTelegramAllowlist = null, setTelegramAllowlist = null, getHostRecoveryStatus = null';
if (!text.includes(oldSig)) {
  console.error('Unexpected local-api.mjs (signature not found).');
  process.exit(1);
}
text = text.replace(oldSig, newSig, 1);
const marker = "if (setTelegramCommands !== null && typeof setTelegramCommands !== 'function') throw new TypeError('setTelegramCommands must be a function or null.');";
const extra = marker + "\n  if (getTelegramAllowlist !== null && typeof getTelegramAllowlist !== 'function') throw new TypeError('getTelegramAllowlist must be a function or null.');\n  if (setTelegramAllowlist !== null && typeof setTelegramAllowlist !== 'function') throw new TypeError('setTelegramAllowlist must be a function or null.');";
if (!text.includes(marker)) {
  console.error('Unexpected local-api.mjs (validation marker not found).');
  process.exit(1);
}
text = text.replace(marker, extra, 1);
const insert = "    if (request.method === 'POST' && pathname === '/api/telegram/bot/verify') {";
const call = "    if (await handleTelegramAllowlistRoutes({ request, response, pathname, getTelegramAllowlist, setTelegramAllowlist, readJson, send })) return;\n" + insert;
if (!text.includes(insert)) {
  console.error('Unexpected local-api.mjs (bot/verify route not found).');
  process.exit(1);
}
text = text.replace(insert, call, 1);
writeFileSync(path, text);
console.log('local-api.mjs updated with allowlist routes.');
