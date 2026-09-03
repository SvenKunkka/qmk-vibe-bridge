# Agent Provider SDK examples (round-17 §5.4)

Connect any agent / LLM / automation tool to Vibe Bridge over the **local
Agent API** — an HTTP endpoint that listens on `127.0.0.1` only and requires a
bearer token.

## 1. Start the local API

In the app: **Providers → Start local API**. The UI shows:

- Address: `http://127.0.0.1:<port>`
- Token: shown once (click *Revoke token* to rotate; the token is stored in
  the macOS Keychain, or a 0600 file as a documented fallback — it is never
  written to logs).

## 2. Send an event (REST)

```sh
curl -X POST http://127.0.0.1:<port>/v1/events \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "eventId": "evt-<unique>",
    "providerId": "my-agent",
    "sessionId": "session-1",
    "state": "thinking",
    "toolName": "run tests",
    "progress": 0.5,
    "requiresApproval": false
  }'
```

or use the bundled CLI:

```sh
node examples/send-event.mjs <port> <token> waiting-approval "review diff"
```

## 3. Event model

```ts
interface InboundAgentEvent {
  eventId: string;          // unique — duplicates are dropped (idempotency)
  providerId: string;
  sessionId: string;
  timestamp?: number;       // epoch ms
  state: 'idle'|'thinking'|'tool-running'|'waiting-approval'|'waiting-user'
       | 'success'|'done'|'error'|'offline';
  progress?: number;        // 0..1
  toolName?: string;
  requiresApproval?: boolean;
  result?: unknown;
  severity?: 'info'|'warn'|'error';
  ttlMs?: number;
  metadata?: Record<string, unknown>;
}
```

## 4. Subscribe (SSE)

```sh
curl -N -H "Authorization: Bearer <TOKEN>" http://127.0.0.1:<port>/v1/events/stream
```

## 5. Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/health` | status (no token needed, no secrets) |
| POST | `/v1/events` | ingest an event |
| POST | `/v1/test` | emit a test event |
| GET | `/v1/events/stream` | SSE stream of normalized events |

## 6. Policy

- Bound to `127.0.0.1`; there is **no public listen** in this release.
- Rate limit (default 600 events/min), max message size (default 64 KiB).
- Conflict policy (Providers page): `priority` (default — a
  waiting-approval/error state is never overwritten by a lower-severity
  event), `latest-active`, or `pinned-session`.
- The token is never logged; the app never sends your cloud API keys.

## OpenAI/Codex-style adapter sketch

A minimal adapter maps tool events to `InboundAgentEvent`:

```js
// codex-adapter.mjs (example — fill in YOUR event source)
const POST = (port, token, body) => fetch(`http://127.0.0.1:${port}/v1/events`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify(body),
});

export async function pushAgentState(port, token, sessionId, state, toolName) {
  await POST(port, token, {
    eventId: `${sessionId}-${Date.now()}`,
    providerId: 'codex-style',
    sessionId,
    state,
    toolName,
  });
}
```
