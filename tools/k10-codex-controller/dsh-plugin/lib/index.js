export const name = 'k10-dsh-focus';
export const inject = ['webServer'];

let sequence = 0;
let latest = { seq: 0, sessionId: '', issuedAt: 0 };

function isLoopback(req) {
  const address = req.socket?.remoteAddress?.toLowerCase();
  return address === '::1' || address?.startsWith('127.') || address?.startsWith('::ffff:127.');
}

function json(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/k10-focus',
    handler(req, res) {
      if (!isLoopback(req)) return json(res, 403, { ok: false, error: 'loopback only' });
      if (req.method === 'GET') return json(res, 200, latest);
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' });
      const sessionId = new URL(req.url, 'http://127.0.0.1').searchParams.get('session') ?? '';
      if (!/^session-[a-zA-Z0-9-]{1,100}$/.test(sessionId)) {
        return json(res, 400, { ok: false, error: 'invalid session id' });
      }
      latest = { seq: ++sequence, sessionId, issuedAt: Date.now() };
      return json(res, 200, { ok: true, ...latest });
    },
  }), 'k10-dsh-focus: local endpoint');
}
