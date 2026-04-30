// =============================================================================
// Karaoke Worker – Cloudflare Workers + Durable Objects
// =============================================================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return cors(new Response(null, { status: 204 }));
    }

    if (url.pathname === '/create') {
      const roomId = crypto.randomUUID().split('-')[0].slice(0, 6);
      // Pre-create the DO so it persists
      const stub = env.KARAOKE_ROOM.get(env.KARAOKE_ROOM.idFromName(roomId));
      await stub.fetch(new Request(new URL('/init', request.url)));
      return cors(json({ roomId }));
    }

    const m = url.pathname.match(/^\/room\/([a-z0-9]+)(\/.*)?$/i);
    if (m) {
      const sub = m[2] || '';
      if (sub === '/time' || sub === '/ws') {
        const stub = env.KARAOKE_ROOM.get(env.KARAOKE_ROOM.idFromName(m[1]));
        return stub.fetch(request);
      }
      // SPA: serve index.html
      return env.ASSETS.fetch(new Request(new URL('/', url.origin), request));
    }

    return env.ASSETS.fetch(request);
  },
};

// =============================================================================
// Durable Object
// =============================================================================
export class KaraokeRoom {
  constructor(state) {
    this.state     = state;
    this.sessions  = [];
    this.playing   = false;
    this.startTime = null;
    this.song      = null;
    this.ready     = false;
  }

  async ensureLoaded() {
    if (this.ready) return;
    // Load persisted state from DO storage
    this.playing   = (await this.state.storage.get('playing'))   ?? false;
    this.startTime = (await this.state.storage.get('startTime')) ?? null;
    this.song      = (await this.state.storage.get('song'))      ?? null;
    this.ready     = true;
  }

  async fetch(request) {
    await this.ensureLoaded();
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return cors(new Response(null, { status: 204 }));
    }

    // Init endpoint – just wakes up and persists the DO
    if (url.pathname.endsWith('/init') || url.pathname === '/init') {
      return cors(json({ ok: true }));
    }

    if (url.pathname.endsWith('/time')) {
      return cors(json({ serverTime: Date.now() }));
    }

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

  handleSession(ws) {
    ws.accept();

    const clientId = crypto.randomUUID();
    const role     = this.sessions.length === 0 ? 'host' : 'participant';
    const session  = { ws, clientId, role };
    this.sessions.push(session);

    ws.send(JSON.stringify({ type: 'joined', role, clientId, serverTime: Date.now() }));

    // Late-joiner sync
    if (this.playing && this.startTime !== null) {
      ws.send(JSON.stringify({ type: 'play', startTime: this.startTime, song: this.song }));
    }

    ws.addEventListener('message', ev => this.onMessage(session, ev.data));
    ws.addEventListener('close',   ()  => this.onClose(session));
    ws.addEventListener('error',   ()  => this.onClose(session));
  }

  async onMessage(session, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'ping':
        session.ws.send(JSON.stringify({
          type: 'pong',
          serverTime: Date.now(),
          clientTime: msg.clientTime,
        }));
        break;

      case 'play':
        if (session.role !== 'host') return;
        this.playing   = true;
        this.startTime = Date.now();
        this.song      = msg.song || 'test';
        // Persist to storage so state survives reconnects
        await this.state.storage.put('playing',   this.playing);
        await this.state.storage.put('startTime', this.startTime);
        await this.state.storage.put('song',      this.song);
        this.broadcast({ type: 'play', startTime: this.startTime, song: this.song });
        break;

      case 'stop':
        if (session.role !== 'host') return;
        this.playing   = false;
        this.startTime = null;
        await this.state.storage.put('playing',   false);
        await this.state.storage.delete('startTime');
        this.broadcast({ type: 'stop' });
        break;
    }
  }

  onClose(session) {
    this.sessions = this.sessions.filter(s => s !== session);

    if (session.role === 'host' && this.sessions.length > 0) {
      const next = this.sessions[0];
      next.role  = 'host';
      next.ws.send(JSON.stringify({ type: 'promoted', role: 'host' }));
    }

    // Note: we do NOT clear playing/startTime here so late-joiners still sync
  }

  broadcast(msg) {
    const raw = JSON.stringify(msg);
    for (const s of this.sessions) {
      try { s.ws.send(raw); } catch { /* ignore */ }
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
