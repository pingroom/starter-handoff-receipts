import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackHandoff } from './tracker.js';
import { createOfflineClient, sampleHandoff } from './offline.js';

const directory = await mkdtemp(join(tmpdir(), 'pingroom-receipt-demo-'));
try {
  console.log('Offline demo: the real SDK uses a synthetic transport. No network or credentials.');
  const controller = new AbortController();
  const resumeClient = createOfflineClient({
    states: ['open', 'acked'],
    onRead: (detail) => { controller.abort(); return detail; },
  });
  const options = { token: 'offline-token', room: 'DEMO', directory, budgetMs: 1000 };
  const pending = await trackHandoff({ ...options, client: resumeClient.client, handoff: sampleHandoff, signal: controller.signal });
  console.log(`Interrupted tracker: ${pending.outcome}; notification ID was saved.`);
  const resumed = await trackHandoff({ ...options, client: resumeClient.client, handoff: sampleHandoff });
  console.log(`Resumed: ${resumed.outcome}; total sends: ${resumeClient.calls.filter((call) => call.method === 'POST').length}.`);
  const expiry = createOfflineClient({ states: ['expired'] });
  const expired = await trackHandoff({ ...options, client: expiry.client, handoff: { ...sampleHandoff, id: 'expired-shift' } });
  console.log(`Another handoff: ${expired.outcome}. No work was executed.`);
} finally { await rm(directory, { recursive: true, force: true }); }
