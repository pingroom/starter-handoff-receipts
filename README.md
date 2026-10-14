# PingRoom handoff receipts

Send an operational handoff and keep a local record of its acknowledgement. Restart the script to continue watching the same notification. An acknowledgement means the recipient confirmed receipt; it does not approve an action or prove the work is complete.

Requires Node.js 22+. Uses the official [`@pingroom/sdk`](https://github.com/pingroom/sdk), pinned to `0.7.0`.

## Try it offline

Click **Use this template**, clone your repository, and run:

```sh
npm ci
npm run demo
npm test
```

The demo uses the real SDK with an in-memory transport. It interrupts a tracker, resumes the saved notification, and records acknowledgement without a second send. It also demonstrates expiry. No network requests or real credentials are used after installation.

## Send your first handoff

1. [Install or open PingRoom](https://pingroom.io/i) and sign in.
2. Run `npm run connect`, open the printed link, and approve the robot's room access. Keep using the same link while installing the app.
3. Edit `handoff.json` with a unique ID and the handoff message.
4. Run `npm start`. The recipient taps **Acknowledge** in PingRoom.

```json
{
  "id": "night-shift-2026-10-14",
  "title": "Shift handoff",
  "message": "Night shift: INC-42 remains under investigation. Acknowledge receipt of these notes; investigation stays open.",
  "ackMode": "any",
  "expiresInSeconds": 900
}
```

Run `npm start` again to resume after a local timeout or interruption. Once a terminal receipt is saved, later runs return it from disk without contacting PingRoom. Use a new ID for each new handoff.

The saved connection is ignored by Git in `.pingroom/credentials.json`. POSIX permissions are `0600` for the credential file and `0700` for its directory. Keep the checkout in your private user directory on Windows.

## Configuration

Copy `.env.example` to `.env` if needed. The scripts load it automatically; existing shell variables take precedence.

| Setting | Default | Meaning |
| --- | --- | --- |
| `PINGROOM_TOKEN`, `PINGROOM_ROOM` | Saved connection | Optional override. Both must be nonblank if either is present; values are never combined with the saved connection. |
| `HANDOFF_FILE` | This repository's `handoff.json` | JSON input; relative paths resolve from your working directory. |
| `RUN_BUDGET_MS` | `60000` | Local tracking budget, 1000–3600000 ms. Reaching it leaves the remote acknowledgement open. |
| `RECEIPTS_DIR` | This repository's `.receipts/` | Persistent state and receipt directory. Keep it across restarts. |

Input limits: ID 1–80 letters/digits/dots/underscores/hyphens; title 1–40 characters; message 1–120 characters; acknowledgement deadline **60–86400 seconds**. The 120-character limit works in private and public rooms. The starter always supplies a deadline.

`ackMode: "any"` waits for the first eligible recipient. `"all"` waits for every original eligible recipient; people joining later are excluded. Partial confirmations remain open. Dismissing a card does not count as acknowledgement. Identity may be redacted, so a receipt can have no acknowledging name.

The connection needs `pingroom:broadcast:send`, `pingroom:notifications:read`, and access to the chosen room. Urgent delivery is independent of acknowledgement; this starter sends at normal priority.

## State and recovery

Each handoff ID gets one atomic JSON state file. It records the notification ID, server acknowledgement status, timestamps, and available confirmation counts. A digest binds it to the exact input, room, and credential; changing any of these blocks reuse of that ID. Tokens are never written into receipt files. Rotating credentials requires restoring the original connection for tracking or adapting the binding with an explicit migration.

The tracker saves `prepared` **before** calling broadcast. If the request fails, the process crashes, or its response is lost before the notification ID is saved, the outcome is **`send_unknown`**. Subsequent runs never automatically send that handoff again. The SDK broadcast method has no exposed idempotency-key option.

To recover an uncertain send:

```sh
npm run find-id
npm start -- --attach-id NOTIFICATION_ID
```

`find-id` reads at most 125 recent visible notifications and prints candidate IDs matching the configured handoff ID and room. It makes no changes. An empty result does not prove no ping was sent; inspect older notification history if needed. `--attach-id` verifies the original message, content hash, handoff ID, room, and acknowledgement policy before saving the ID. A mismatched candidate is rejected without sending anything.

If no send can be confirmed, leave its state intact while investigating. Only create a new handoff ID when you intentionally want a new notification. Deleting state can permit a duplicate. The starter does not guarantee exactly-once delivery.

The store allows at most 100 handoff records and refuses new sends when full. Archive completed receipts elsewhere to make room, retaining a record of their IDs so you do not reuse them. Keep pending and uncertain records. State files above 32 KiB or malformed state are rejected.

Only one tracker uses a receipt directory at a time. After an abrupt kill, `.receipts/.lock` may remain. Verify its recorded PID and every other tracker using that directory are stopped, then remove **only the lock file**. Do not delete the JSON receipts.

## Tracking behavior

Only the server's `acked` or `expired` state completes a receipt. A local timeout, dismissal, network error, or passed clock deadline never becomes an acknowledgement. No handler, command, or deployment runs after a receipt.

Each SDK wait holds for up to 20 seconds; immediate responses are spaced at least 2.1 seconds apart to stay below the route's 30-waits/minute limit. The SDK adds a ten-second transport buffer to each hold; the local budget and Ctrl+C abort the wait. Create and single-notification reads do not accept an SDK signal, so their underlying requests may remain alive for up to the configured five-second HTTP timeout after tracking stops. Disk operations must finish before the lock is released.

`find-id` is a separate bounded history scan: at most five requests with five-second request timeouts. Ctrl+C stops after the current read.

Exit codes: `0` acknowledged; `2` expired; `3` pending/stopped; `4` unknown send outcome; `1` configuration, persistence, or API error. API errors preserve known notification IDs for later retry. Standard output includes the local receipt path; private API error bodies and tokens are not logged.

## Adapt it

- `src/tracker.js`: validation, send/resume workflow, and receipt fields.
- `src/store.js`: atomic local persistence and exclusive lock.
- `handoff.json`: your operational message and acknowledgement rule.

Tests cover send/resume, uncertain-send recovery, mismatched configuration, acknowledgement/expiry, partial confirmations, aborts, deadlines, polling pace, and local locking. GitHub CI tests Node 22 and 24 and runs the offline demo without secrets.

For a decision before executing work, use [starter-human-review](https://github.com/pingroom/starter-human-review). For automatic service outage and recovery alerts, use [starter-uptime-monitor](https://github.com/pingroom/starter-uptime-monitor).

MIT licensed. See [LICENSE](LICENSE).
