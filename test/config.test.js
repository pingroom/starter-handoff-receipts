import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCredentials } from '../src/config.js';

test('full environment credentials ignore malformed saved state', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pingroom-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'credentials.json');
  await writeFile(path, 'not json');
  assert.deepEqual(await loadCredentials({ PINGROOM_TOKEN: 'new-token', PINGROOM_ROOM: 'ROOM' }, path), { token: 'new-token', room: 'ROOM' });
});

test('partial or blank environment pairs never borrow saved credentials', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pingroom-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'credentials.json');
  await writeFile(path, JSON.stringify({ token: 'saved-token', room: 'SAVED' }));
  for (const env of [{ PINGROOM_TOKEN: 'new-token' }, { PINGROOM_ROOM: 'ROOM' }, { PINGROOM_TOKEN: ' ', PINGROOM_ROOM: 'ROOM' }]) {
    await assert.rejects(loadCredentials(env, path), /both/);
  }
  assert.deepEqual(await loadCredentials({}, path), { token: 'saved-token', room: 'SAVED' });
});
