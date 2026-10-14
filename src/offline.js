import { PingRoom } from '@pingroom/sdk';

export const sampleHandoff = Object.freeze({
  id: 'example-shift', title: 'Shift handoff', message: 'Shift notes are ready. Acknowledge receipt when you have them.', ackMode: 'any', expiresInSeconds: 900,
});

/** Real SDK with an in-memory transport. No network or local credentials. */
export function createOfflineClient({ states = ['open', 'acked'], sendError, onRead, onWait } = {}) {
  const calls = [];
  let sent;
  let position = 0;
  const action = () => {
    const status = states[Math.min(position++, states.length - 1)];
    return {
      status, requires_ack: true, mode: sent.ack_mode,
      acked_at: status === 'acked' ? new Date().toISOString() : null,
      expires_at: new Date(Date.now() + (status === 'expired' ? -1000 : 900_000)).toISOString(),
      acked_by: status === 'acked' ? { id: 'offline-human', name: 'Example teammate' } : null,
      confirmed_count: status === 'acked' ? 1 : 0, required_count: 1, dismissed_count: 0,
    };
  };
  const fetch = async (url, init) => {
    const target = new URL(url);
    if (target.origin !== 'https://receipts-demo.invalid') throw new Error('Unexpected offline origin.');
    calls.push({ method: init.method, path: target.pathname, body: init.body ? JSON.parse(init.body) : null });
    let response;
    if (init.method === 'POST' && target.pathname === '/api/agent/rooms/DEMO/notifications') {
      sent = JSON.parse(init.body);
      if (sendError) throw sendError;
      response = { ...sent, id: 'offline-notification' };
    } else if (init.method === 'GET' && target.pathname === '/api/agent/notifications/offline-notification' && sent) {
      response = { ...sent, id: 'offline-notification', room: { invite_code: 'DEMO' }, action_state: action() };
      if (onRead) response = await onRead(response, init.signal);
    } else if (init.method === 'GET' && target.pathname === '/api/agent/notifications/offline-notification/ack/wait' && sent) {
      response = { id: 'offline-notification', action_state: action() };
      if (onWait) response = await onWait(response, init.signal);
    } else throw new Error('Unexpected offline request.');
    return new Response(JSON.stringify(response), { headers: { 'content-type': 'application/json' } });
  };
  return {
    client: new PingRoom({ token: 'offline-token', baseUrl: 'https://receipts-demo.invalid', timeoutMs: 5000, fetch }),
    calls,
  };
}
