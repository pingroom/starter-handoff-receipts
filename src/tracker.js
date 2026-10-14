import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { openStore } from './store.js';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const date = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const validId = (value) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,255}$/.test(value);

export class TrackerError extends Error {
  constructor(code, message) { super(message); this.name = 'TrackerError'; this.code = code; }
}

export function validateHandoff(input) {
  // The server trims whitespace from the ends of every string it stores, and
  // the saved notification is compared with what was sent, so trim first.
  const title = typeof input?.title === 'string' ? input.title.trim() : null;
  const message = typeof input?.message === 'string' ? input.message.trim() : null;
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).sort().join(',') !== 'ackMode,expiresInSeconds,id,message,title'
    || typeof input.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(input.id)
    || !title || [...title].length > 40
    || !message || [...message].length > 120
    || !['any', 'all'].includes(input.ackMode)
    || !Number.isInteger(input.expiresInSeconds) || input.expiresInSeconds < 60 || input.expiresInSeconds > 86400) {
    throw new TrackerError('invalid_handoff', 'Expected id, title (1–40 chars), message (1–120 chars), ackMode (any/all), expiresInSeconds (60–86400).');
  }
  return Object.freeze({ id: input.id, title, message, ackMode: input.ackMode, expiresInSeconds: input.expiresInSeconds });
}

function bounded(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

function observation(action, mode) {
  if (!action || action.requires_ack !== true || !['open', 'acked', 'expired'].includes(action.status)
    || (action.mode ?? 'any') !== mode || !date(action.expires_at)
    || (action.status === 'acked' && !date(action.acked_at))) {
    throw new TrackerError('invalid_ack_state', 'Server did not return a valid acknowledgement state for this handoff.');
  }
  for (const key of ['confirmed_count', 'required_count', 'dismissed_count']) {
    if (action[key] !== undefined && (!Number.isSafeInteger(action[key]) || action[key] < 0)) {
      throw new TrackerError('invalid_ack_state', 'Server returned invalid confirmation counts.');
    }
  }
  return {
    status: action.status, mode, ackedAt: action.acked_at ?? null, expiresAt: action.expires_at,
    observedAt: new Date().toISOString(),
    ackedBy: action.acked_by && typeof action.acked_by === 'object' ? {
      id: typeof action.acked_by.id === 'string' ? action.acked_by.id : null,
      name: typeof action.acked_by.name === 'string' ? action.acked_by.name : null,
    } : null,
    confirmedCount: action.confirmed_count ?? null,
    requiredCount: action.required_count ?? null,
    dismissedCount: action.dismissed_count ?? null,
  };
}

function assertDetail(detail, id, handoff, inputHash, room) {
  const remoteRoom = detail?.room?.invite_code ?? detail?.room?.code;
  if (detail?.id !== id || detail.message !== handoff.message
    || detail.correlation_id !== `handoff-${inputHash}`
    || detail.data?.handoff_id !== handoff.id || detail.data?.handoff_hash !== inputHash
    || typeof remoteRoom !== 'string' || remoteRoom.toUpperCase() !== room.toUpperCase()) {
    throw new TrackerError('notification_mismatch', 'Notification does not match this handoff, content, and room.');
  }
}

function assertSaved(state, binding, handoffId) {
  const receipt = state?.receipt;
  if (!state || state.version !== 1 || state.handoffId !== handoffId || !['prepared', 'tracking', 'complete'].includes(state.phase)
    || !date(state.createdAt) || (state.phase !== 'prepared' && !validId(state.notificationId))
    || (state.lastWaitStarted !== undefined && (!Number.isSafeInteger(state.lastWaitStarted) || state.lastWaitStarted < 0))
    || (state.phase === 'prepared' && state.notificationId !== null)
    || (receipt !== null && (!receipt || !['open', 'acked', 'expired'].includes(receipt.status)
      || !['any', 'all'].includes(receipt.mode) || !date(receipt.expiresAt) || !date(receipt.observedAt)
      || (receipt.status === 'acked' && !date(receipt.ackedAt))))
    || (state.phase === 'complete' && !['acked', 'expired'].includes(receipt?.status))) {
    throw new TrackerError('invalid_state', 'Receipt state is invalid. Restore a valid backup.');
  }
  if (state.binding !== binding) throw new TrackerError('binding_mismatch', 'This handoff ID belongs to different content, room, or connection. Restore that configuration or use a new ID for a new handoff.');
}

/** Send at most once per local ID; subsequent runs only read the saved ping. */
export async function trackHandoff({ client, token, room, handoff: input, directory, budgetMs = 60_000, signal, attachId }) {
  const handoff = validateHandoff(input);
  if (typeof token !== 'string' || !token.trim() || typeof room !== 'string' || !room.trim()) throw new TrackerError('invalid_connection', 'A complete PingRoom connection is required.');
  if (!Number.isInteger(budgetMs) || budgetMs < 1 || budgetMs > 3_600_000) throw new TrackerError('invalid_budget', 'Run budget must be 1–3600000 milliseconds.');
  if (attachId !== undefined && !validId(attachId)) throw new TrackerError('invalid_id', 'Provide a valid notification ID.');
  const inputHash = hash(JSON.stringify(handoff));
  const binding = hash(JSON.stringify({ inputHash, room: room.toUpperCase(), credentialHash: hash(token) }));
  const controller = new AbortController();
  const stop = () => controller.abort(new TrackerError('stopped', 'Tracking stopped locally.'));
  if (signal?.aborted) stop();
  signal?.addEventListener('abort', stop, { once: true });
  const deadline = Date.now() + budgetMs;
  const timer = setTimeout(() => controller.abort(new TrackerError('run_budget', 'Run budget reached; resume with the same handoff.')), budgetMs);
  let store, state;
  const result = (outcome) => ({ outcome, notificationId: state?.notificationId ?? null, receipt: state?.receipt ?? null, path: store?.path });
  try {
    controller.signal.throwIfAborted();
    store = await openStore(directory, hash(handoff.id));
    state = await store.read();
    if (state) assertSaved(state, binding, handoff.id);
    if (state?.phase === 'complete') return result(state.receipt.status);
    if (attachId && !state) throw new TrackerError('nothing_to_recover', 'Attach an ID only to an existing uncertain handoff.');
    if (state?.notificationId && attachId && state.notificationId !== attachId) throw new TrackerError('already_tracking', 'A different notification is already tracked.');
    if (!state) {
      state = { version: 1, handoffId: handoff.id, binding, phase: 'prepared', notificationId: null, receipt: null, createdAt: new Date().toISOString() };
      await store.write(state);
      // A durable prepared record precedes the uninterruptible create. After a
      // crash or uncertain response, a later run must not create another ping.
      controller.signal.throwIfAborted();
      let sent;
      try {
        sent = await bounded(Promise.resolve().then(() => client.broadcast(room, {
          title: handoff.title, message: handoff.message, requires_ack: true, ack_mode: handoff.ackMode,
          ack_timeout_seconds: handoff.expiresInSeconds, correlation_id: `handoff-${inputHash}`,
          data: { handoff_id: handoff.id, handoff_hash: inputHash },
        })), controller.signal);
      } catch { return result('send_unknown'); }
      if (!validId(sent?.id)) return result('send_unknown');
      state = { ...state, phase: 'tracking', notificationId: sent.id };
      try { await store.write(state); }
      catch {
        const error = new TrackerError('save_failed', 'Ping created but its ID could not be saved. Restore storage and recover using the notification ID.');
        error.notificationId = sent.id;
        throw error;
      }
    }
    if (state.phase === 'prepared' && !attachId) return result('send_unknown');
    controller.signal.throwIfAborted();
    const id = state.notificationId ?? attachId;
    const detail = await bounded(Promise.resolve().then(() => client.notifications.getNotification(id)), controller.signal);
    assertDetail(detail, id, handoff, inputHash, room);
    let receipt = observation(detail.action_state, handoff.ackMode);
    state = { ...state, notificationId: id, phase: receipt.status === 'open' ? 'tracking' : 'complete', receipt };
    await store.write(state);
    let lastWaitStarted = state.lastWaitStarted ?? 0;
    while (receipt.status === 'open') {
      controller.signal.throwIfAborted();
      if (Date.now() >= deadline) return result('pending');
      // Even an immediate open response cannot exceed the route's 30/min limit.
      await sleep(Math.max(0, 2100 - (Date.now() - lastWaitStarted)), undefined, { signal: controller.signal });
      controller.signal.throwIfAborted();
      lastWaitStarted = Date.now();
      state = { ...state, lastWaitStarted };
      await store.write(state);
      controller.signal.throwIfAborted();
      const timeout = Math.min(20, Math.max(0, Math.floor((deadline - Date.now()) / 1000)));
      const update = await bounded(Promise.resolve().then(() => client.notifications.waitForAcknowledgement(id, { timeout, signal: controller.signal })), controller.signal);
      if (update?.id !== id) throw new TrackerError('notification_mismatch', 'Wait returned a different notification.');
      receipt = observation(update.action_state, handoff.ackMode);
      state = { ...state, phase: receipt.status === 'open' ? 'tracking' : 'complete', receipt };
      await store.write(state);
    }
    return result(receipt.status);
  } catch (error) {
    if (controller.signal.aborted || ['run_budget', 'stopped'].includes(error.code)) return result(state?.notificationId ? 'pending' : state ? 'send_unknown' : 'stopped');
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
    await store?.close();
  }
}
