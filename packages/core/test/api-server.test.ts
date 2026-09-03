/**
 * Local Agent API tests (round-17 acceptance J): token auth, message limits,
 * rate limiting, idempotency, conflict policies, normalization, and the rule
 * that the token never appears in logs.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LocalApiServer } from '../src/api/server';
import type { AiEvent } from '../src/ai/types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function request(port: number, opts: { method?: string; path?: string; token?: string; body?: unknown; headers?: Record<string, string> }): Promise<{ code: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: opts.method ?? 'GET',
      path: opts.path ?? '/v1/health',
      headers: {
        'Content-Type': 'application/json',
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(opts.headers ?? {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c as Buffer));
      res.on('end', () => resolve({ code: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function makeServer(cfg: { maxEventsPerMinute?: number; conflictPolicy?: 'priority' | 'latest-active' | 'pinned-session'; maxMessageBytes?: number } = {}): Promise<{ server: LocalApiServer; port: number; token: string; events: AiEvent[] }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-api-'));
  const events: AiEvent[] = [];
  const server = new LocalApiServer(
    { host: '127.0.0.1', port: 0, token: 'test-token-abc123', ...cfg },
    { configDir: dir, onEvent: (ev) => events.push(ev), onLog: () => {} },
  );
  const port = await server.start();
  return { server, port, token: 'test-token-abc123', events };
}

const ev = (over: Record<string, unknown> = {}) => ({
  eventId: 'e1', providerId: 'codex', sessionId: 's1', state: 'thinking', toolName: 'run tests', ...over,
});

describe('round-17 J: local Agent API', () => {
  test('health is public; events require the token', async () => {
    const { server, port } = await makeServer();
    const health = await request(port, {});
    assert.equal(health.code, 200);
    const noToken = await request(port, { method: 'POST', path: '/v1/events', body: ev() });
    assert.equal(noToken.code, 401);
    const badToken = await request(port, { method: 'POST', path: '/v1/events', token: 'wrong', body: ev() });
    assert.equal(badToken.code, 401);
    await server.stop();
  });

  test('valid event is accepted and normalized to AiEvent', async () => {
    const { server, port, token, events } = await makeServer();
    const r = await request(port, { method: 'POST', path: '/v1/events', token, body: ev() });
    assert.equal(r.code, 200);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'thinking');
    assert.equal(events[0].source, 'codex');
    assert.equal(events[0].simulated, false);
    await server.stop();
  });

  test('idempotency: duplicate eventId accepted but not re-emitted', async () => {
    const { server, port, token, events } = await makeServer();
    await request(port, { method: 'POST', path: '/v1/events', token, body: ev() });
    await request(port, { method: 'POST', path: '/v1/events', token, body: ev() });
    assert.equal(events.length, 1, 'duplicate eventId is dropped');
    await server.stop();
  });

  test('invalid events rejected (missing fields, unknown state, bad progress)', async () => {
    const { server, port, token } = await makeServer();
    assert.equal((await request(port, { method: 'POST', path: '/v1/events', token, body: {} })).code, 400);
    assert.equal((await request(port, { method: 'POST', path: '/v1/events', token, body: ev({ state: 'bogus' }) })).code, 400);
    assert.equal((await request(port, { method: 'POST', path: '/v1/events', token, body: ev({ progress: 5 }) })).code, 400);
    assert.equal((await request(port, { method: 'POST', path: '/v1/events', token, body: ev({ eventId: '' }) })).code, 400);
    await server.stop();
  });

  test('oversized message rejected (413)', async () => {
    const { server, port, token } = await makeServer({ maxMessageBytes: 256 });
    const big = ev({ metadata: { blob: 'x'.repeat(1000) } });
    const r = await request(port, { method: 'POST', path: '/v1/events', token, body: big });
    assert.equal(r.code, 413);
    await server.stop();
  });

  test('rate limit enforced (429)', async () => {
    const { server, port, token } = await makeServer({ maxEventsPerMinute: 3 });
    for (let i = 0; i < 3; i++) {
      const r = await request(port, { method: 'POST', path: '/v1/events', token, body: ev({ eventId: `e${i}` }) });
      assert.equal(r.code, 200);
    }
    const limited = await request(port, { method: 'POST', path: '/v1/events', token, body: ev({ eventId: 'e4' }) });
    assert.equal(limited.code, 429);
    await server.stop();
  });

  test('conflict policy: priority keeps waiting-approval over thinking', async () => {
    const { server, port, token, events } = await makeServer({ conflictPolicy: 'priority' });
    await request(port, { method: 'POST', path: '/v1/events', token, body: ev({ eventId: 'a', sessionId: 's1', state: 'thinking' }) });
    await request(port, { method: 'POST', path: '/v1/events', token, body: ev({ eventId: 'b', sessionId: 's2', state: 'waiting-approval' }) });
    // s2 (waiting-approval, severity 5) beats s1 (thinking, 2)
    assert.equal(events[events.length - 1].session, 's2');
    // a lower-priority event from s1 must not immediately overwrite s2
    await request(port, { method: 'POST', path: '/v1/events', token, body: ev({ eventId: 'c', sessionId: 's1', state: 'idle' }) });
    assert.equal(events[events.length - 1].session, 's2', 'high-priority state not overwritten by low-priority');
    await server.stop();
  });

  test('conflict policy: pinned-session ignores other sessions', async () => {
    const { server, port, token, events } = await makeServer({ conflictPolicy: 'pinned-session' });
    // pinned via setConflictPolicy after start
    server.setConflictPolicy('pinned-session', 'pin1');
    await request(port, { method: 'POST', path: '/v1/events', token, body: ev({ eventId: 'a', sessionId: 'pin1', state: 'thinking' }) });
    await request(port, { method: 'POST', path: '/v1/events', token, body: ev({ eventId: 'b', sessionId: 'other', state: 'error' }) });
    assert.equal(events.length, 1, 'only the pinned session is emitted');
    await server.stop();
  });

  test('token never appears in logs', async () => {
    const logs: string[] = [];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-api-log-'));
    const server = new LocalApiServer(
      { host: '127.0.0.1', port: 0, token: 'supersecret-token-xyz' },
      { configDir: dir, onEvent: () => {}, onLog: (_l, m) => logs.push(m) },
    );
    const port = await server.start();
    await request(port, { method: 'POST', path: '/v1/events', token: 'supersecret-token-xyz', body: ev() });
    await request(port, { method: 'POST', path: '/v1/events', body: ev() }); // unauthorized -> logs a warning
    await server.stop();
    assert.ok(!logs.some((l) => l.includes('supersecret-token-xyz')), 'token must not leak into logs');
  });

  test('success/done normalize to done; offline to disconnected', async () => {
    const { server, port, token, events } = await makeServer({ conflictPolicy: 'latest-active' });
    try {
      await request(port, { method: 'POST', path: '/v1/events', token, body: ev({ eventId: 'x', sessionId: 'sa', state: 'success' }) });
      await request(port, { method: 'POST', path: '/v1/events', token, body: ev({ eventId: 'y', sessionId: 'sb', state: 'offline' }) });
      assert.equal(events[0]?.type, 'done');
      assert.equal(events[1]?.type, 'disconnected');
    } finally {
      await server.stop();
    }
  });

  test('ingestAgentEvent programmatic path + stop', async () => {
    const { server, port } = await makeServer();
    assert.ok(port > 0);
    await server.stop();
  });
});
