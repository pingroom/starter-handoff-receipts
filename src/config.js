import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { validateHandoff } from './tracker.js';

export const credentialsPath = new URL('../.pingroom/credentials.json', import.meta.url);

export function loadEnv() {
  try { process.loadEnvFile(); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Could not read .env.'); }
}

export async function loadCredentials(env = process.env, path = credentialsPath) {
  let token, room;
  if (env.PINGROOM_TOKEN !== undefined || env.PINGROOM_ROOM !== undefined) {
    token = env.PINGROOM_TOKEN; room = env.PINGROOM_ROOM;
  } else {
    try { ({ token, room } = JSON.parse(await readFile(path, 'utf8'))); }
    catch { throw new Error('Run npm run connect or provide both PINGROOM_TOKEN and PINGROOM_ROOM.'); }
  }
  if (typeof token !== 'string' || !token.trim() || typeof room !== 'string' || !room.trim()) {
    throw new Error('Provide both PINGROOM_TOKEN and PINGROOM_ROOM; partial pairs are never combined.');
  }
  return { token: token.trim(), room: room.trim() };
}

export async function loadConfig(env = process.env) {
  const path = env.HANDOFF_FILE || new URL('../handoff.json', import.meta.url);
  if ((await stat(path)).size > 16_384) throw new Error('Handoff input file must be at most 16 KiB.');
  const handoff = validateHandoff(JSON.parse(await readFile(path, 'utf8')));
  const budgetMs = Number(env.RUN_BUDGET_MS ?? 60_000);
  if (!Number.isInteger(budgetMs) || budgetMs < 1000 || budgetMs > 3_600_000) throw new Error('RUN_BUDGET_MS must be 1000–3600000.');
  return {
    ...await loadCredentials(env), handoff, budgetMs,
    directory: env.RECEIPTS_DIR || fileURLToPath(new URL('../.receipts/', import.meta.url)),
  };
}
