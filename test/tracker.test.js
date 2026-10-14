import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { trackHandoff, validateHandoff } from '../src/tracker.js';
import { createOfflineClient, sampleHandoff } from '../src/offline.js';

async function setup(t, offline = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'pingroom-receipt-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const transport = createOfflineClient(offline);
  return { ...transport, options: { client: transport.client, directory, token: 'offline-token', room: 'DEMO', handoff: { ...sampleHandoff }, budgetMs: 1000 } };
}
const sends = (calls) => calls.filter((call) => call.method === 'POST');

test('sends an ack-required ping and persists a receipt, without executing work', async (t) => {
  const { options, calls } = await setup(t);
  const result = await trackHandoff(options);
  assert.equal(result.outcome, 'acked');
  assert.equal(result.receipt.ackedBy.name, 'Example teammate');
  assert.equal(sends(calls).length, 1);
  assert.equal(sends(calls)[0].body.requires_ack, true);
  assert.equal(sends(calls)[0].body.ack_timeout_seconds, 900);
  const saved = JSON.parse(await readFile(result.path, 'utf8'));
  assert.equal(saved.phase, 'complete');
  assert.equal(saved.notificationId, result.notificationId);
  assert.ok(!JSON.stringify(saved).includes('offline-token'));
});

test('a completed handoff is returned locally on the next run with no new requests', async (t) => {
  const { options, calls } = await setup(t);
  const first = await trackHandoff(options);
  const count = calls.length;
  assert.equal((await trackHandoff(options)).outcome, 'acked');
  assert.equal(calls.length, count);
  assert.equal(JSON.parse(await readFile(first.path, 'utf8')).phase, 'complete');
});

test('server expiry is stored as expired, never as acknowledgement', async (t) => {
  const { options } = await setup(t, { states: ['expired'] });
  const result = await trackHandoff(options);
  assert.equal(result.outcome, 'expired');
  assert.equal(result.receipt.ackedAt, null);
});

test('run-budget timeout preserves the notification ID and resumes without resending', async (t) => {
  let terminal = false;
  const { options, calls } = await setup(t, {
    states: ['open'],
    onRead: (detail) => terminal ? { ...detail, action_state: { ...detail.action_state, status: 'acked', acked_at: new Date().toISOString() } } : detail,
  });
  const pending = await trackHandoff({ ...options, budgetMs: 1000 });
  assert.equal(pending.outcome, 'pending');
  assert.equal(pending.notificationId, 'offline-notification');
  terminal = true;
  assert.equal((await trackHandoff(options)).outcome, 'acked');
  assert.equal(sends(calls).length, 1);
});

test('caller cancellation preserves a tracking record without cancelling the remote ping', async (t) => {
  const controller = new AbortController();
  const { options, calls } = await setup(t, { onRead: (detail) => { controller.abort(); return detail; } });
  const result = await trackHandoff({ ...options, signal: controller.signal });
  assert.equal(result.outcome, 'pending');
  assert.equal(JSON.parse(await readFile(result.path, 'utf8')).notificationId, 'offline-notification');
  assert.ok(!calls.some((call) => call.path.includes('cancel')));
});

test('already-aborted runs create no state and make no requests', async (t) => {
  const { options, calls } = await setup(t);
  assert.equal((await trackHandoff({ ...options, signal: AbortSignal.abort() })).outcome, 'stopped');
  assert.equal(calls.length, 0);
  assert.deepEqual(await readdir(options.directory), []);
});

test('unknown send outcome blocks automatic resend and can attach a verified notification', async (t) => {
  const { options, calls } = await setup(t, { sendError: new Error('network lost after remote accept'), states: ['acked'] });
  const first = await trackHandoff(options);
  assert.equal(first.outcome, 'send_unknown');
  assert.equal(JSON.parse(await readFile(first.path, 'utf8')).phase, 'prepared');
  assert.equal((await trackHandoff(options)).outcome, 'send_unknown');
  const attached = await trackHandoff({ ...options, attachId: 'offline-notification' });
  assert.equal(attached.outcome, 'acked');
  assert.equal(sends(calls).length, 1);
});

test('attaching a notification requires an existing uncertain state', async (t) => {
  const { options, calls } = await setup(t);
  await assert.rejects(trackHandoff({ ...options, attachId: 'some-notification' }), { code: 'nothing_to_recover' });
  assert.equal(calls.length, 0);
});

test('recovery rejects a notification for different content without changing uncertain state', async (t) => {
  const { options, calls } = await setup(t, { sendError: new Error('unknown'), onRead: (detail) => ({ ...detail, data: { handoff_id: 'other' } }) });
  const first = await trackHandoff(options);
  await assert.rejects(trackHandoff({ ...options, attachId: 'offline-notification' }), { code: 'notification_mismatch' });
  assert.equal(JSON.parse(await readFile(first.path, 'utf8')).phase, 'prepared');
  assert.equal(sends(calls).length, 1);
});

for (const update of [{ token: 'different-token' }, { room: 'OTHER' }, { handoff: { ...sampleHandoff, message: 'Changed content' } }]) {
  test(`same handoff ID rejects changed ${Object.keys(update)[0]}`, async (t) => {
    const { options, calls } = await setup(t);
    await trackHandoff(options);
    await assert.rejects(trackHandoff({ ...options, ...update }), { code: 'binding_mismatch' });
    assert.equal(sends(calls).length, 1);
  });
}

test('malformed stored terminal state fails closed', async (t) => {
  const { options, calls } = await setup(t);
  const result = await trackHandoff(options);
  const state = JSON.parse(await readFile(result.path, 'utf8'));
  state.receipt = { status: 'acked' };
  await writeFile(result.path, JSON.stringify(state));
  await assert.rejects(trackHandoff(options), { code: 'invalid_state' });
  assert.equal(sends(calls).length, 1);
});

test('a JSON null receipt cannot be mistaken for a missing file and resent', async (t) => {
  const { options, calls } = await setup(t);
  const result = await trackHandoff(options);
  await writeFile(result.path, 'null');
  await assert.rejects(trackHandoff(options), /Cannot read receipt state/);
  assert.equal(sends(calls).length, 1);
});

test('read failures preserve the saved ID and do not become receipt success', async (t) => {
  const { options, calls } = await setup(t, { onRead: () => { throw new Error('read failed'); } });
  await assert.rejects(trackHandoff(options), /read failed/);
  await assert.rejects(trackHandoff(options), /read failed/);
  assert.equal(sends(calls).length, 1);
});

test('wait response must name the saved notification', async (t) => {
  const { options } = await setup(t, { onWait: (result) => ({ ...result, id: 'wrong-notification' }) });
  await assert.rejects(trackHandoff(options), { code: 'notification_mismatch' });
});

test('acked state without an acknowledgement timestamp is rejected', async (t) => {
  const { options } = await setup(t, { states: ['acked'], onRead: (detail) => ({ ...detail, action_state: { ...detail.action_state, acked_at: null } }) });
  await assert.rejects(trackHandoff(options), { code: 'invalid_ack_state' });
});

test('redacted acknowledging identity is a valid receipt', async (t) => {
  const { options } = await setup(t, { states: ['acked'], onRead: (detail) => ({ ...detail, action_state: { ...detail.action_state, acked_by: null } }) });
  const result = await trackHandoff(options);
  assert.equal(result.outcome, 'acked');
  assert.equal(result.receipt.ackedBy, null);
});

test('all mode preserves partial and dismissed counts, using server status', async (t) => {
  const counts = { confirmed_count: 1, required_count: 2, dismissed_count: 1 };
  const { options } = await setup(t, {
    states: ['open', 'expired'],
    onRead: (detail) => ({ ...detail, action_state: { ...detail.action_state, ...counts } }),
    onWait: (result) => ({ ...result, action_state: { ...result.action_state, ...counts } }),
  });
  const result = await trackHandoff({ ...options, handoff: { ...sampleHandoff, ackMode: 'all' } });
  assert.equal(result.outcome, 'expired');
  assert.equal(result.receipt.confirmedCount, 1);
  assert.equal(result.receipt.requiredCount, 2);
  assert.equal(result.receipt.dismissedCount, 1);
});

test('local clock passing expiry never invents a terminal server state', async (t) => {
  const pastExpiry = (result) => ({ ...result, action_state: { ...result.action_state, expires_at: new Date(0).toISOString() } });
  const { options } = await setup(t, { states: ['open'], onRead: pastExpiry, onWait: pastExpiry });
  const result = await trackHandoff({ ...options, budgetMs: 1000 });
  assert.equal(result.outcome, 'pending');
  assert.equal(result.receipt.status, 'open');
});

test('immediate open responses are paced below 30 waits per minute', async (t) => {
  const starts = [];
  const { options } = await setup(t, { states: ['open', 'open', 'acked'], onWait: (value) => { starts.push(Date.now()); return value; } });
  assert.equal((await trackHandoff({ ...options, budgetMs: 5000 })).outcome, 'acked');
  assert.equal(starts.length, 2);
  assert.ok(starts[1] - starts[0] >= 2000);
});

test('exclusive state lock prevents concurrent senders', async (t) => {
  let entered, release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const reading = new Promise((resolve) => { entered = resolve; });
  const { options, calls } = await setup(t, { states: ['acked'], onRead: async (detail) => { entered(); await waiting; return detail; } });
  const first = trackHandoff(options);
  await reading;
  await assert.rejects(trackHandoff(options), /locked/);
  release();
  assert.equal((await first).outcome, 'acked');
  assert.equal(sends(calls).length, 1);
});

test('payload limits are validated before sending', async (t) => {
  const { options, calls } = await setup(t);
  for (const update of [{ expiresInSeconds: 59 }, { expiresInSeconds: 86401 }, { message: 'x'.repeat(121) }, { title: 'x'.repeat(41) }, { ackMode: 'majority' }, { command: 'do something' }]) {
    await assert.rejects(trackHandoff({ ...options, handoff: { ...sampleHandoff, ...update } }), { code: 'invalid_handoff' });
  }
  assert.equal(calls.length, 0);
  assert.equal(validateHandoff({ ...sampleHandoff, message: '🕊'.repeat(120) }).message.length, 240);
});

test('title and message are trimmed, as the server trims what it stores', () => {
  const handoff = validateHandoff({ ...sampleHandoff, title: ' Shift change ', message: 'Keys are in the box.\n' });
  assert.equal(handoff.title, 'Shift change');
  assert.equal(handoff.message, 'Keys are in the box.');
  assert.throws(() => validateHandoff({ ...sampleHandoff, message: ' \n ' }), { code: 'invalid_handoff' });
});

test('invisible marks the server trims are trimmed too, so the saved notification matches', async (t) => {
  // RLM, ZWSP and the soft hyphen survive JS trim(), but Laravel's TrimStrings
  // drops them, so the server stores the message without them.
  for (const tail of ['\u200F', '\u200B', '\u00AD']) {
    const { options, calls } = await setup(t, { onRead: (detail) => ({ ...detail, message: 'Keys are in the box.' }) });
    const result = await trackHandoff({ ...options, handoff: { ...sampleHandoff, message: `Keys are in the box.${tail}` } });
    assert.equal(result.outcome, 'acked', JSON.stringify(tail));
    assert.equal(sends(calls)[0].body.message, 'Keys are in the box.');
  }
  assert.equal(validateHandoff({ ...sampleHandoff, title: '\u200BShift change\u00AD' }).title, 'Shift change');
  assert.throws(() => validateHandoff({ ...sampleHandoff, message: '\u200B\u200F\u00AD' }), { code: 'invalid_handoff' });
});
