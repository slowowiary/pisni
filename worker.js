// =============================================================================
// Karaoke Worker
// =============================================================================
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));

    if (url.pathname === '/create') {
      const roomId   = crypto.randomUUID().split('-')[0].slice(0, 6);
      const clientId = url.searchParams.get('clientId') || crypto.randomUUID();
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
    this.state        = state;
    this.sessions     = [];
    this.playing      = false;
    this.paused       = false;
    this.startTime    = null;  // серверний ms старту (з урахуванням пауз)
    this.pauseTime    = null;  // серверний ms коли поставили на паузу
    this.song         = null;
    this.hostClientId = null;
    this.syncAudio    = false; // чи грати музику на всіх
    this.ready        = false;
  }

  async ensureLoaded() {
    if (this.ready) return;
    this.playing      = (await this.state.storage.get('playing'))      ?? false;
    this.paused       = (await this.state.storage.get('paused'))       ?? false;
    this.startTime    = (await this.state.storage.get('startTime'))    ?? null;
    this.pauseTime    = (await this.state.storage.get('pauseTime'))    ?? null;
    this.song         = (await this.state.storage.get('song'))         ?? null;
    this.hostClientId = (await this.state.storage.get('hostClientId')) ?? null;
    this.syncAudio    = (await this.state.storage.get('syncAudio'))    ?? false;
    this.ready        = true;
  }

  async fetch(request) {
    await this.ensureLoaded();
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));

    if (url.pathname.endsWith('/init') || url.pathname === '/init') {
      const hid = url.searchParams.get('hostClientId');
      if (hid) { this.hostClientId = hid; await this.state.storage.put('hostClientId', hid); }
      return cors(json({ ok: true }));
    }
    if (url.pathname.endsWith('/time')) return cors(json({ serverTime: Date.now() }));
    if (url.pathname.endsWith('/ws')) {
      if (request.headers.get('Upgrade') !== 'websocket')
        return new Response('Expected WebSocket', { status: 426 });
      const [client, server] = Object.values(new WebSocketPair());
      this.handleSession(server);
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response('Not found', { status: 404 });
  }

  handleSession(ws) {
    ws.accept();
    const session = { ws, clientId: null, role: 'participant' };
    this.sessions.push(session);

    const timeout = setTimeout(() => {
      if (!session.clientId) { session.clientId = crypto.randomUUID(); this.finalizeJoin(session); }
    }, 5000);

    ws.addEventListener('message', ev => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'hello' && !session.clientId) {
        clearTimeout(timeout);
        session.clientId = msg.clientId;
        if (this.hostClientId && msg.clientId === this.hostClientId) session.role = 'host';
        else if (!this.hostClientId) {
          session.role = 'host'; this.hostClientId = msg.clientId;
          this.state.storage.put('hostClientId', msg.clientId);
        }
        this.finalizeJoin(session); return;
      }
      this.onMessage(session, msg);
    });

    ws.addEventListener('close', () => this.onClose(session));
    ws.addEventListener('error', () => this.onClose(session));
  }

  finalizeJoin(session) {
    session.ws.send(JSON.stringify({
      type: 'joined', role: session.role,
      clientId: session.clientId, serverTime: Date.now(),
    }));
    // Late-joiner sync
    if (this.playing && !this.paused && this.startTime !== null) {
      session.ws.send(JSON.stringify({ type: 'play', startTime: this.startTime, song: this.song }));
      if (this.syncAudio) {
        session.ws.send(JSON.stringify({ type: 'sync_audio', enabled: true }));
      }
    } else if (this.playing && this.paused) {
      session.ws.send(JSON.stringify({ type: 'play', startTime: this.startTime, song: this.song }));
      session.ws.send(JSON.stringify({ type: 'pause', pauseTime: this.pauseTime }));
    }
  }

  async onMessage(session, msg) {
    switch (msg.type) {
      case 'ping':
        session.ws.send(JSON.stringify({ type: 'pong', serverTime: Date.now(), clientTime: msg.clientTime }));
        break;

      case 'play':
        if (session.role !== 'host') return;
        this.playing   = true; this.paused = false;
        // +2.5s щоб всі встигли завантажити буфер і точно синхронізуватись
        this.startTime = Date.now() + 2500;
        this.song      = msg.song || 'test';
        await this.state.storage.put('playing',   true);
        await this.state.storage.put('paused',    false);
        await this.state.storage.put('startTime', this.startTime);
        await this.state.storage.put('song',      this.song);
        this.broadcast({ type: 'play', startTime: this.startTime, song: this.song });
        break;

      case 'pause':
        if (session.role !== 'host' || !this.playing || this.paused) return;
        this.paused    = true;
        this.pauseTime = Date.now();
        await this.state.storage.put('paused',    true);
        await this.state.storage.put('pauseTime', this.pauseTime);
        this.broadcast({ type: 'pause', pauseTime: this.pauseTime });
        break;

      case 'resume':
        if (session.role !== 'host' || !this.paused) return;
        // Зміщуємо startTime вперед на час паузи + затримку синхронізації
        const pauseDuration = Date.now() - this.pauseTime;
        this.startTime = this.startTime + pauseDuration + 2500;
        this.paused    = false; this.pauseTime = null;
        await this.state.storage.put('paused',    false);
        await this.state.storage.put('startTime', this.startTime);
        await this.state.storage.delete('pauseTime');
        this.broadcast({ type: 'resume', startTime: this.startTime, song: this.song });
        break;

      case 'stop':
        if (session.role !== 'host') return;
        this.playing = false; this.paused = false;
        this.startTime = null; this.pauseTime = null; this.syncAudio = false;
        await this.state.storage.put('playing', false);
        await this.state.storage.put('paused',  false);
        await this.state.storage.delete('startTime');
        await this.state.storage.delete('pauseTime');
        await this.state.storage.put('syncAudio', false);
        this.broadcast({ type: 'stop' });
        break;

      case 'sync_audio':
        if (session.role !== 'host') return;
        this.syncAudio = msg.enabled;
        await this.state.storage.put('syncAudio', msg.enabled);
        // Транслюємо тільки учасникам (не хосту)
        for (const s of this.sessions) {
          if (s.role !== 'host') {
            try { s.ws.send(JSON.stringify({ type: 'sync_audio', enabled: msg.enabled })); } catch {}
          }
        }
        break;
    }
  }

  onClose(session) {
    this.sessions = this.sessions.filter(s => s !== session);
  }

  broadcast(msg) {
    const raw = JSON.stringify(msg);
    for (const s of this.sessions) { try { s.ws.send(raw); } catch {} }
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
function cors(response) {
  const r = new Response(response.body, response);
  r.headers.set('Access-Control-Allow-Origin',  '*');
  r.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  r.headers.set('Access-Control-Allow-Headers', 'Content-Type');
  return r;
}
