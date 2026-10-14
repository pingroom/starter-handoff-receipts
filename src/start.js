import { PingRoom } from '@pingroom/sdk';
import { loadConfig, loadEnv } from './config.js';
import { trackHandoff, TrackerError } from './tracker.js';

const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());
try {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--attach-id')) throw new TrackerError('usage', 'Usage: npm start [-- --attach-id NOTIFICATION_ID]');
  loadEnv();
  const config = await loadConfig();
  const client = new PingRoom({ token: config.token, timeoutMs: 5000 });
  const result = await trackHandoff({ ...config, client, signal: controller.signal, attachId: args[1] });
  console.log(`Handoff ${config.handoff.id}: ${result.outcome}`);
  if (result.notificationId) console.log(`Notification: ${result.notificationId}`);
  if (result.path) console.log(`Receipt file: ${result.path}`);
  if (result.receipt) console.log(JSON.stringify(result.receipt, null, 2));
  if (result.outcome === 'pending') console.log('Run npm start again with the same configuration to resume. No new ping will be sent.');
  if (result.outcome === 'send_unknown') console.log('Send outcome is unknown. Do not resend; see README to recover the notification ID.');
  process.exitCode = { acked: 0, expired: 2, pending: 3, stopped: 3, send_unknown: 4 }[result.outcome] ?? 1;
} catch (error) {
  // SDK response bodies and arbitrary network error messages may contain private data.
  console.error(error instanceof TrackerError ? `${error.code}: ${error.message}` : 'Could not track the handoff. Check configuration, connection, permissions, and local state; see README.');
  if (error instanceof TrackerError && error.notificationId) console.error(`Recover notification: ${error.notificationId}`);
  process.exitCode = 1;
}
