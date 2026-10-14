import { mkdir, chmod, open, stat, readFile, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

export async function openStore(directory, key) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const lockPath = join(directory, '.lock');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch { throw new Error('Receipt store is locked. See README for safe crash recovery.'); }
  const path = join(directory, `${key}.json`);
  const temporary = join(directory, '.receipt.tmp');
  try { await lock.writeFile(String(process.pid)); }
  catch (error) { await lock.close(); await rm(lockPath, { force: true }); throw error; }
  return {
    path,
    async read() {
      try {
        if ((await stat(path)).size > 32_768) throw new Error('Receipt file exceeds its size limit.');
        const value = JSON.parse(await readFile(path, 'utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid receipt object.');
        return value;
      } catch (error) { if (error.code === 'ENOENT') return null; throw new Error('Cannot read receipt state. Restore a valid backup; do not delete uncertain state.'); }
    },
    async write(value) {
      try { await stat(path); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        if ((await readdir(directory)).filter((name) => name.endsWith('.json')).length >= 100) {
          throw new Error('Receipt store has 100 entries. Archive completed receipts before sending another handoff.');
        }
      }
      const file = await open(temporary, 'w', 0o600);
      try { await file.writeFile(`${JSON.stringify(value, null, 2)}\n`); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, path);
    },
    async close() {
      await lock.close();
      await rm(temporary, { force: true });
      await rm(lockPath, { force: true });
    },
  };
}
