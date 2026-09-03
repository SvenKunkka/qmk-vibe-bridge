/**
 * Local Agent API server (round-17 §5): a 127.0.0.1-only HTTP endpoint for
 * agents/LLMs/automation to push AI events.
 *
 *   POST /v1/events      ingest an InboundAgentEvent (Bearer token)
 *   POST /v1/test        emit a test event (Bearer token)
 *   GET  /v1/health      status (no secrets)
 *   GET  /v1/events/stream  SSE stream of normalized events (Bearer token)
 *
 * Safety: bound to 127.0.0.1 only (no public listen), token required, max
 * message size, rate limit, idempotency (eventId), conflict policy, TTL.
 * The token is never logged.
 */

import * as http from 'node:http';
import type { AiEvent, AiEventType } from '../ai/types';
import { normalizeEventType } from '../ai/normalizer';
import {
  STATE_SEVERITY, type ApiServerConfig, type ApiServerStatus,
  type ConflictPolicy, type InboundAgentEvent,
} from './types';

export interface LocalApiServerOptions {
  configDir: string;
  onEvent?: (ev: AiEvent) => void;
  onLog?: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

interface SessionState {
  sessionId: string;
  severity: number;
  ts: number;
}

const DEFAULT_MAX_BYTES = 64 * 1024;
const DEFAULT_RATE = 600; // events per minute

export class LocalApiServer {
  private server: http.Server | null = null;
  private readonly host: string;
  private readonly port: number;
  private readonly token: string;
  private readonly maxMessageBytes: number;
  private readonly maxEventsPerMinute: number;
  private conflictPolicy: ConflictPolicy;
  private pinnedSessionId?: string;
  private readonly configDir: string;
  private readonly onEvent?: (ev: AiEvent) => void;
  private readonly onLog: (level: 'info' | 'warn' | 'error', msg: string) => void;

  private tokenStorage: 'keychain' | 'file' | 'none' = 'file';
  private running = false;
  private boundPort = 0;

  // idempotency + rate limiting
  private readonly seenEvents = new Map<string, number>(); // eventId -> ts
  private readonly eventTimestamps: number[] = [];
  private readonly sessions = new Map<string, SessionState>();

  private sseClients = new Set<http.ServerResponse>();

  constructor(cfg: ApiServerConfig, opts: LocalApiServerOptions) {
    this.host = cfg.host ?? '127.0.0.1';
    this.port = cfg.port ?? 0;
    this.token = cfg.token ?? '';
    this.maxMessageBytes = cfg.maxMessageBytes ?? DEFAULT_MAX_BYTES;
    this.maxEventsPerMinute = cfg.maxEventsPerMinute ?? DEFAULT_RATE;
    this.conflictPolicy = cfg.conflictPolicy ?? 'priority';
    this.pinnedSessionId = cfg.pinnedSessionId;
    this.configDir = opts.configDir;
    this.onEvent = opts.onEvent;
    this.onLog = opts.onLog ?? (() => {});
  }

  get status(): ApiServerStatus {
    return {
      running: this.running,
      host: this.host,
      port: this.boundPort,
      tokenConfigured: this.token.length > 0,
      tokenStorage: this.tokenStorage,
      conflictPolicy: this.conflictPolicy,
    };
  }

  getPort(): number {
    return this.boundPort;
  }

  getToken(): string {
    return this.token;
  }

  setConflictPolicy(p: ConflictPolicy, pinnedSessionId?: string): void {
    this.conflictPolicy = p;
    this.pinnedSessionId = pinnedSessionId;
  }

  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this.handle(req, res));
      this.server = server;
      server.on('error', reject);
      server.listen(this.port, this.host, () => {
        this.running = true;
        const addr = server.address() as { port: number };
        this.boundPort = addr.port;
        this.onLog('info', `local Agent API listening on http://${this.host}:${this.boundPort} (127.0.0.1 only, token required)`);
        resolve(this.boundPort);
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      for (const s of this.sseClients) {
        try { s.end(); } catch { /* ignore */ }
      }
      this.sseClients.clear();
      this.running = false;
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      this.server = null;
    });
  }

  private unauthorized(res: http.ServerResponse): void {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
  }

  private tooLarge(res: http.ServerResponse): void {
    res.writeHead(413, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'message too large' }));
  }

  private rateLimited(res: http.ServerResponse): void {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'rate limit exceeded' }));
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = (req.url ?? '/').split('?')[0];
    // auth for everything except health
    if (url === '/v1/health') {
      this.respondJson(res, 200, { ok: true, service: 'vibebridge-local-api', host: this.host, port: this.boundPort });
      return;
    }
    const auth = req.headers.authorization ?? '';
    const expected = `Bearer ${this.token}`;
    if (auth !== expected || this.token.length === 0) {
      this.onLog('warn', 'local API: unauthorized request rejected');
      this.unauthorized(res);
      return;
    }

    if (url === '/v1/events' && req.method === 'POST') {
      this.ingest(req, res);
      return;
    }
    if (url === '/v1/test' && req.method === 'POST') {
      this.testEvent(res);
      return;
    }
    if (url === '/v1/events/stream' && req.method === 'GET') {
      this.openSse(res);
      return;
    }
    this.respondJson(res, 404, { ok: false, error: 'not found' });
  }

  private respondJson(res: http.ServerResponse, code: number, body: unknown): void {
    const data = JSON.stringify(body);
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
    res.end(data);
  }

  private ingest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > this.maxMessageBytes) {
        this.tooLarge(res);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (res.writableEnded) return;
      let ev: InboundAgentEvent;
      try {
        ev = JSON.parse(Buffer.concat(chunks).toString('utf8')) as InboundAgentEvent;
      } catch {
        this.respondJson(res, 400, { ok: false, error: 'invalid JSON' });
        return;
      }
      const outcome = this.ingestEvent(ev);
      this.respondJson(res, outcome.code, { ok: outcome.code === 200, ...(outcome.error ? { error: outcome.error } : { accepted: true, eventId: ev.eventId }) });
    });
  }

  /** validate + normalize + conflict-policy + emit. Returns HTTP outcome. */
  ingestEvent(ev: InboundAgentEvent): { code: number; error?: string } {
    if (!ev || typeof ev !== 'object') return { code: 400, error: 'event must be an object' };
    if (typeof ev.eventId !== 'string' || ev.eventId.length === 0 || ev.eventId.length > 128) return { code: 400, error: 'eventId required (<=128 chars)' };
    if (typeof ev.providerId !== 'string' || ev.providerId.length === 0) return { code: 400, error: 'providerId required' };
    if (typeof ev.sessionId !== 'string' || ev.sessionId.length === 0) return { code: 400, error: 'sessionId required' };
    if (!(ev.state in STATE_SEVERITY)) return { code: 400, error: `unknown state "${ev.state}"` };
    if (ev.progress !== undefined && (typeof ev.progress !== 'number' || ev.progress < 0 || ev.progress > 1)) return { code: 400, error: 'progress must be 0..1' };

    // idempotency
    const now = Date.now();
    if (this.seenEvents.has(ev.eventId)) return { code: 200 }; // duplicate — accepted, not re-emitted
    this.seenEvents.set(ev.eventId, now);
    if (this.seenEvents.size > 10000) {
      for (const [k, v] of this.seenEvents) if (now - v > 600_000) this.seenEvents.delete(k);
    }

    // rate limit
    this.eventTimestamps.push(now);
    while (this.eventTimestamps.length > 0 && now - this.eventTimestamps[0] > 60_000) this.eventTimestamps.shift();
    if (this.eventTimestamps.length > this.maxEventsPerMinute) {
      this.seenEvents.delete(ev.eventId);
      this.onLog('warn', 'local API: rate limit exceeded');
      return { code: 429, error: 'rate limit exceeded' };
    }

    // conflict policy
    if (!this.policyAllows(ev, now)) {
      return { code: 200 }; // accepted but suppressed by conflict policy
    }

    const type = normalizeInboundState(ev.state);
    const aiEvent: AiEvent = {
      type,
      source: ev.providerId,
      agent: ev.providerId,
      agentId: ev.providerId,
      session: ev.sessionId,
      text: typeof ev.toolName === 'string' ? ev.toolName : typeof ev.result === 'string' ? ev.result : undefined,
      step: ev.toolName,
      progress: ev.progress,
      ts: ev.timestamp ?? now,
      confidence: 1,
      simulated: false,
    };
    this.onEvent?.(aiEvent);
    return { code: 200 };
  }

  private policyAllows(ev: InboundAgentEvent, now: number): boolean {
    const severity = STATE_SEVERITY[ev.state];
    if (this.conflictPolicy === 'latest-active') return true;
    if (this.conflictPolicy === 'pinned-session') {
      return this.pinnedSessionId === undefined || ev.sessionId === this.pinnedSessionId;
    }
    // priority: only replace the current best session if strictly higher
    // severity, or same severity but more recent
    const cur = this.sessions.get(ev.sessionId);
    if (cur) {
      cur.severity = severity;
      cur.ts = now;
    } else {
      this.sessions.set(ev.sessionId, { sessionId: ev.sessionId, severity, ts: now });
    }
    let best: SessionState | null = null;
    for (const s of this.sessions.values()) {
      if (!best || s.severity > best.severity || (s.severity === best.severity && s.ts > best.ts)) best = s;
    }
    return best !== null && best.sessionId === ev.sessionId;
  }

  private testEvent(res: http.ServerResponse): void {
    this.onEvent?.({
      type: 'thinking', source: 'local-api-test', agent: 'Test', agentId: 'test',
      session: 'test-session', text: 'test event from local API', ts: Date.now(),
      confidence: 1, simulated: false,
    });
    this.respondJson(res, 200, { ok: true, event: 'test' });
  }

  private openSse(res: http.ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('event: ready\ndata: {"ok":true}\n\n');
    this.sseClients.add(res);
    const heartbeat = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { clearInterval(heartbeat); this.sseClients.delete(res); }
    }, 15000);
    res.on('close', () => {
      clearInterval(heartbeat);
      this.sseClients.delete(res);
    });
  }

  /** broadcast a normalized event to SSE subscribers */
  broadcast(ev: AiEvent): void {
    const data = JSON.stringify(ev);
    for (const s of this.sseClients) {
      try { s.write(`event: ai\ndata: ${data}\n\n`); } catch { this.sseClients.delete(s); }
    }
  }
}

export function normalizeInboundState(state: string): AiEventType {
  if (state === 'success' || state === 'done') return 'done';
  if (state === 'offline') return 'disconnected';
  return normalizeEventType(state);
}
