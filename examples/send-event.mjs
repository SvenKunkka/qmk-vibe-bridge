#!/usr/bin/env node
/**
 * send-event.mjs — local Agent API example CLI (round-17 §5.4).
 *
 *   node examples/send-event.mjs <port> <token> <state> [toolName] [eventId]
 *
 * Sends one InboundAgentEvent to the app's local API (127.0.0.1 only).
 * The token comes from the app's Providers page; it is NEVER written to any
 * log by this script.
 */

const [port, token, state, toolName, eventId] = process.argv.slice(2);
if (!port || !token || !state) {
  console.error('usage: node examples/send-event.mjs <port> <token> <state> [toolName] [eventId]');
  console.error('  states: idle | thinking | tool-running | waiting-approval | waiting-user | success | done | error | offline');
  process.exit(2);
}

const payload = {
  eventId: eventId ?? `cli-${Date.now()}`,
  providerId: 'cli-example',
  sessionId: 'cli-session',
  timestamp: Date.now(),
  state,
  toolName: toolName ?? undefined,
};

fetch(`http://127.0.0.1:${port}/v1/events`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  },
  body: JSON.stringify(payload),
})
  .then(async (res) => {
    const body = await res.text();
    if (!res.ok) {
      console.error(`rejected (${res.status}): ${body}`);
      process.exit(1);
    }
    console.log(`accepted (${res.status}): ${body}`);
  })
  .catch((err) => {
    console.error(`request failed: ${err.message}`);
    process.exit(1);
  });
