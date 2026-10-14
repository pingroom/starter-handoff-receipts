import { PingRoom } from '@pingroom/sdk';
import { loadConfig, loadEnv } from './config.js';

// A bounded, read-only aid for an uncertain send; attachment verifies full content.
let stopped = false;
process.once('SIGINT', () => { stopped = true; });
process.once('SIGTERM', () => { stopped = true; });
try {
  loadEnv();
  const { token, room, handoff } = await loadConfig();
  const client = new PingRoom({ token, timeoutMs: 5000 });
  let matches = 0;
  for (let page = 1; page <= 5 && !stopped; page++) {
    const history = await client.notifications.list({ limit: 25, page });
    for (const item of history.data) {
      const code = item.room?.invite_code ?? item.room?.code;
      if (item.data?.handoff_id === handoff.id && typeof code === 'string' && code.toUpperCase() === room.toUpperCase()) {
        console.log(`Candidate notification: ${item.id}`);
        matches++;
      }
    }
    if (history.data.length < 25) break;
  }
  console.log(`Found ${matches} candidates in at most 125 recent notifications. No ping sent and no state changed.`);
  console.log('An empty result does not prove the send failed. Follow the README recovery steps.');
  if (stopped) process.exitCode = 3;
} catch {
  console.error('Could not read notification history. Check the connection and notifications:read scope.');
  process.exitCode = 1;
}
