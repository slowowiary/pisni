// =============================================================================
// Karaoke Worker – Cloudflare Workers + Durable Objects
// =============================================================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));

    if (url.pathname === '/create') {
      const roomId   = crypto.randomUUID().split('-')[0].slice(0, 6);
      const clientId = url.searchParams.get('clientId') || crypto.randomUUID();
      // Ініціалізуємо DO і зберігаємо hostClientId
      const stub = env.KARAOKE_ROOM.get(env.KARAOKE_ROOM.idFromName(roomId));
      await stub.fetch(new Request(
        new URL(`/init?hostClientId=${encodeURIComponent(clientId)}`, url).toString()
      ));
      return cors(json({ roomId }));
    }

    const m = url.pathname.match(/^\/room\/([a-z0-9]+)(\/.*)?$/i);
    if (m) {
      const sub = m[2] || '';
      if (sub === '/time' || sub === '/ws') {
        const stub = env.KARAOKE_ROOM.get(env.KARAOKE_ROOM.idFromName(m[1]));
        return stub.fetch(request);
      }
      return env.ASSETS.fetch(new Request(new URL('/', url.origin).toString()));
    }

    return env.ASSETS.fetch(request);
  },
};

// =============================================================================
// Durable Object
// =============================================================================
export class KaraokeRoom {
  constructor(state) {
    this.state          = state;
    this.sessions       = [];
    this.playing        = false;
    this.startTime      = null;
    this.song           = null;
    this.hostClientId   = null; // постійний ID хоста
    this.ready          = false;
  }

  async ensureLoaded() {
    if (this.ready) return;
    this.playing      = (await this.state.storage.get('playing'))      ?? false;
    this.startTime    = (await this.state.storage.get('startTime'))    ?? null;
    this.song         = (await this.state.storage.get('song'))         ?? null;
    this.hostClientId = (await this.state.storage.get('hostClientId')) ?? null;
    this.ready        = true;
  }

  async fetch(request) {
    await this.ensureLoaded();
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));

    // Ініціалізація кімнати — зберігаємо хто хост
    if (url.pathname.endsWith('/init') || url.pathname === '/init') {
      const hostClientId = url.searchParams.get('hostClientId');
      if (hostClientId) {
        this.hostClientId = hostClientId;
        await this.state.storage.put('hostClientId', hostClientId);
      }
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
    // Роль визначається після того як клієнт надішле 'hello' з clientId
    const session = { ws, clientId: null, role: 'participant' };
    this.sessions.push(session);

    // Даємо 5 секунд щоб надіслати hello, інакше залишається participant
    const helloTimeout = setTimeout(() => {
      if (!session.clientId) {
        session.clientId = crypto.randomUUID();
        this.finalizeJoin(session);
      }
    }, 5000);

    ws.addEventListener('message', ev => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }

      if (msg.type === 'hello' && !session.clientId) {
        clearTimeout(helloTimeout);
        session.clientId = msg.clientId;
        // Перевіряємо чи це оригінальний хост
        if (this.hostClientId && msg.clientId === this.hostClientId) {
          session.role = 'host';
        } else if (!this.hostClientId) {
          // Перша людина в порожній кімнаті стає хостом
          session.role      = 'host';
          this.hostClientId = msg.clientId;
          this.state.storage.put('hostClientId', msg.clientId);
        }
        this.finalizeJoin(session);
        return;
      }

      this.onMessage(session, ev.data);
    });

    ws.addEventListener('close', () => this.onClose(session));
    ws.addEventListener('error', () => this.onClose(session));
  }

  finalizeJoin(session) {
    session.ws.send(JSON.stringify({
      type: 'joined',
      role: session.role,
      clientId: session.clientId,
      serverTime: Date.now(),
    }));

    // Late-joiner sync
    if (this.playing && this.startTime !== null) {
      session.ws.send(JSON.stringify({ type: 'play', startTime: this.startTime, song: this.song }));
    }
  }

  async onMessage(session, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'ping':
        session.ws.send(JSON.stringify({ type: 'pong', serverTime: Date.now(), clientTime: msg.clientTime }));
        break;

      case 'play':
        if (session.role !== 'host') return;
        this.playing   = true;
        this.startTime = Date.now() + 2000; // +2s щоб всі встигли підготуватись
        this.song      = msg.song || 'test';
        await this.state.storage.put('playing',   true);
        await this.state.storage.put('startTime', this.startTime);
        await this.state.storage.put('song',      this.song);
        this.broadcast({ type: 'play', startTime: this.startTime, song: this.song });
        break;

      case 'stop':
        if (session.role !== 'host') return;
        this.playing   = false;
        this.startTime = null;
        await this.state.storage.put('playing', false);
        await this.state.storage.delete('startTime');
        this.broadcast({ type: 'stop' });
        break;
    }
  }

  onClose(session) {
    this.sessions = this.sessions.filter(s => s !== session);
    // Хост пішов — але НЕ передаємо роль автоматично
    // Хост повернеться зі своїм clientId і відновить роль
  }

  broadcast(msg) {
    const raw = JSON.stringify(msg);
    for (const s of this.sessions) {
      try { s.ws.send(raw); } catch {}
    }
  }
}

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
