// =============================================================================
// Karaoke Worker
// =============================================================================
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));

    // GET /api/songs — читає auto-generated songs/index.json
    if (url.pathname === '/api/songs') {
      try {
        const r = await env.ASSETS.fetch(new Request(new URL('/songs/index.json', url.origin)));
        if (r.ok) {
          const text = await r.text();
          return cors(new Response(text, { headers: { 'Content-Type': 'application/json' } }));
        }
      } catch {}
      return cors(json([]));
    }

    // POST /room/:id/host-stop — зупиняє відтворення якщо запит від хоста
    const stopMatch = url.pathname.match(/^\/room\/([a-z0-9]+)\/host-stop$/i);
    if (stopMatch) {
      const clientId = url.searchParams.get('clientId') || '';
      const stub = env.KARAOKE_ROOM.get(env.KARAOKE_ROOM.idFromName(stopMatch[1]));
      return stub.fetch(new Request(
        new URL(`/host-stop?clientId=${encodeURIComponent(clientId)}`, url).toString(),
        { method: 'POST' }
      ));
    }

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
      if (sub === '/time' || sub === '/ws' || sub === '/state') {
        const stub = env.KARAOKE_ROOM.get(env.KARAOKE_ROOM.idFromName(m[1]));
        return stub.fetch(request);
      }
      return env.ASSETS.fetch(new Request(new URL('/', url.origin).toString()));
    }
    return env.ASSETS.fetch(request);
  },
};

// =============================================================================
// Сканування пісень через __STATIC_CONTENT_MANIFEST
// Cloudflare автоматично надає цю змінну — це JSON з усіма файлами assets
// =============================================================================


// =============================================================================
// Durable Object
// =============================================================================
export class KaraokeRoom {
  constructor(state) {
    this.state        = state;
    this.sessions     = [];
    this.playing      = false;
    this.paused       = false;
    this.startTime    = null;
    this.pauseTime    = null;
    this.song         = null;
    this.hostClientId = null;
    this.syncAudio    = false;
    this.noWords      = false; // false = зі словами (файл "<song>1"), true = акапело (файл "<song>")
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
    this.noWords      = (await this.state.storage.get('noWords'))      ?? false;
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

    if (url.pathname.endsWith('/host-stop')) {
      const clientId = url.searchParams.get('clientId') || '';
      // Перевіряємо що це справжній хост
      if (this.hostClientId && clientId === this.hostClientId) {
        this.playing = false; this.paused = false;
        this.startTime = null; this.pauseTime = null;
        await this.state.storage.put('playing', false);
        await this.state.storage.put('paused', false);
        await this.state.storage.delete('startTime');
        await this.state.storage.delete('pauseTime');
        this.broadcast({ type: 'stop' });
      }
      return cors(json({ ok: true }));
    }
    if (url.pathname.endsWith('/state')) {
      return cors(json({ syncAudio: this.syncAudio }));
    }
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
      syncAudio: this.syncAudio,
      volume: this.volume ?? 0.8,
    }));
    if (this.playing && !this.paused && this.startTime !== null) {
      session.ws.send(JSON.stringify({ type: 'play', startTime: this.startTime, song: this.song, syncAudio: this.syncAudio, noWords: this.noWords }));
    } else if (this.playing && this.paused) {
      session.ws.send(JSON.stringify({ type: 'play', startTime: this.startTime, song: this.song, syncAudio: this.syncAudio, noWords: this.noWords }));
      session.ws.send(JSON.stringify({ type: 'pause', pauseTime: this.pauseTime }));
    }
    if (!this.playing && this.syncAudio) {
      session.ws.send(JSON.stringify({ type: 'sync_audio', enabled: true, song: this.song, noWords: this.noWords }));
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
        this.startTime = Date.now() + 3000;
        this.song      = msg.song || 'test';
        this.noWords   = !!msg.noWords;
        await this.state.storage.put('playing',   true);
        await this.state.storage.put('paused',    false);
        await this.state.storage.put('startTime', this.startTime);
        await this.state.storage.put('song',      this.song);
        await this.state.storage.put('noWords',   this.noWords);
        this.broadcast({ type: 'play', startTime: this.startTime, song: this.song, syncAudio: this.syncAudio, volume: this.volume ?? 0.8, noWords: this.noWords });
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
        this.startTime = this.startTime + (Date.now() - this.pauseTime) + 2000;
        this.paused    = false; this.pauseTime = null;
        await this.state.storage.put('paused',    false);
        await this.state.storage.put('startTime', this.startTime);
        await this.state.storage.delete('pauseTime');
        this.broadcast({ type: 'resume', startTime: this.startTime, song: this.song, syncAudio: this.syncAudio, noWords: this.noWords });
        break;

      case 'stop':
        if (session.role !== 'host') return;
        this.playing = false; this.paused = false;
        this.startTime = null; this.pauseTime = null;
        await this.state.storage.put('playing', false);
        await this.state.storage.put('paused',  false);
        await this.state.storage.delete('startTime');
        await this.state.storage.delete('pauseTime');
        this.broadcast({ type: 'stop' });
        break;

      case 'sync_audio':
        if (session.role !== 'host') return;
        this.syncAudio = msg.enabled;
        if (msg.noWords !== undefined) this.noWords = !!msg.noWords;
        await this.state.storage.put('syncAudio', msg.enabled);
        await this.state.storage.put('noWords',   this.noWords);
        for (const s of this.sessions) {
          if (s.role !== 'host') {
            try { s.ws.send(JSON.stringify({ type: 'sync_audio', enabled: msg.enabled, song: this.song, noWords: this.noWords })); } catch {}
          }
        }
        break;

      case 'set_volume':
        if (session.role !== 'host') return;
        this.volume = Math.max(0, Math.min(1, msg.volume ?? 0.8));
        // Broadcast to all including host so UI stays in sync
        this.broadcast({ type: 'set_volume', volume: this.volume });
        break;

      case 'debug_log':
        // Debug logging support — used when DEBUG_SYNC=true in app.js
        // Forwards client sync logs to host so all devices' logs appear in one panel.
        // Safe to leave here: when DEBUG_SYNC=false, clients never send debug_log messages.
        if (session.role === 'host') return;
        for (const s of this.sessions) {
          if (s.role === 'host') {
            try { s.ws.send(JSON.stringify(msg)); } catch {}
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
