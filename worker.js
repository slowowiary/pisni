// =============================================================================
// Karaoke Worker – Cloudflare Workers + Durable Objects
// =============================================================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return cors(new Response(null, { status: 204 }));
    }

    // POST /create  →  generate a fresh room ID
    if (url.pathname === '/create') {
      const roomId = crypto.randomUUID().split('-')[0].slice(0, 6);
      return cors(json({ roomId }));
    }

    // /room/:id/time   or   /room/:id/ws
    const m = url.pathname.match(/^\/room\/([a-z0-9]+)(\/.*)?$/i);
    if (m) {
      const stub = env.KARAOKE_ROOM.get(env.KARAOKE_ROOM.idFromName(m[1]));
      return stub.fetch(request);
    }

    return new Response('Not found', { status: 404 });
  },
};

// =============================================================================
// Durable Object – one instance per room
// =============================================================================
export class KaraokeRoom {
  constructor(state) {
    this.state = state;
    // Kept in memory; DO stays alive while WebSockets are open.
    this.sessions = []; // Array<{ ws, clientId, role }>
    this.playing   = false;
    this.startTime = null; // server-side ms timestamp of play start
    this.song      = null;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return cors(new Response(null, { status: 204 }));
    }

    // ── GET /room/:id/time ──────────────────────────────────────────────────
    if (url.pathname.endsWith('/time')) {
      return cors(json({ serverTime: Date.now() }));
    }

    // ── GET /room/:id/ws  (WebSocket upgrade) ───────────────────────────────
    if (url.pathname.endsWith('/ws')) {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected WebSocket upgrade', { status: 426 });
      }
      const [client, server] = Object.values(new WebSocketPair());
      this.handleSession(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response('Not found', { status: 404 });
  }

  // ---------------------------------------------------------------------------
  handleSession(ws) {
    ws.accept();

    const clientId = crypto.randomUUID();
    const role     = this.sessions.length === 0 ? 'host' : 'participant';
    const session  = { ws, clientId, role };
    this.sessions.push(session);

    // Tell the client who they are
    ws.send(JSON.stringify({ type: 'joined', role, clientId, serverTime: Date.now() }));

    // Late-joiner: send current playback state so they sync immediately
    if (this.playing && this.startTime !== null) {
      ws.send(JSON.stringify({ type: 'play', startTime: this.startTime, song: this.song }));
    }

    ws.addEventListener('message', ev  => this.onMessage(session, ev.data));
    ws.addEventListener('close',   ()  => this.onClose(session));
    ws.addEventListener('error',   ()  => this.onClose(session));
  }

  // ---------------------------------------------------------------------------
  onMessage(session, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      // Client → server time probe (NTP-style)
      case 'ping':
        session.ws.send(JSON.stringify({
          type: 'pong',
          serverTime: Date.now(),
          clientTime: msg.clientTime,   // echo back so client can compute RTT
        }));
        break;

      // Host starts playback
      case 'play':
        if (session.role !== 'host') return;
        this.playing   = true;
        this.startTime = Date.now();
        this.song      = msg.song || 'test';
        this.broadcast({ type: 'play', startTime: this.startTime, song: this.song });
        break;

      // Host stops playback
      case 'stop':
        if (session.role !== 'host') return;
        this.playing   = false;
        this.startTime = null;
        this.broadcast({ type: 'stop' });
        break;
    }
  }

  // ---------------------------------------------------------------------------
  onClose(session) {
    this.sessions = this.sessions.filter(s => s !== session);

    // If host left, promote the next client
    if (session.role === 'host' && this.sessions.length > 0) {
      const next  = this.sessions[0];
      next.role   = 'host';
      next.ws.send(JSON.stringify({ type: 'promoted', role: 'host' }));
    }

    if (this.sessions.length === 0) {
      this.playing   = false;
      this.startTime = null;
    }
  }

  // ---------------------------------------------------------------------------
  broadcast(msg) {
    const raw = JSON.stringify(msg);
    for (const s of this.sessions) {
      try { s.ws.send(raw); } catch { /* ignore closed sockets */ }
    }
  }
}

// =============================================================================
// Helpers
// =============================================================================
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function cors(response) {
  const r = new Response(response.body, response);
  r.headers.set('Access-Control-Allow-Origin',  '*');
  r.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  r.headers.set('Access-Control-Allow-Headers', 'Content-Type');
  return r;
}
