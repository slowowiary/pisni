// =============================================================================
// Karaoke – frontend
// =============================================================================

// ── CONFIGURE THIS after deploying the worker ─────────────────────────────────
const WORKER_URL = 'https://karaoke-worker.slovo-wiry.workers.dev';
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

// ── State ────────────────────────────────────────────────────────────────────
let ws        = null;
let role      = null;   // 'host' | 'participant'
let offset    = 0;      // serverTime – clientTime  (ms)
let startTime = null;   // server timestamp (ms) when playback began
let playing   = false;
let lyrics    = [];     // [{ word, start, end }, ...]
let animFrame = null;
let roomId    = null;

// ── DOM refs ─────────────────────────────────────────────────────────────────
const homeView  = document.getElementById('home-view');
const roomView  = document.getElementById('room-view');
const createBtn = document.getElementById('create-btn');
const playBtn   = document.getElementById('play-btn');
const roomUrlEl = document.getElementById('room-url');
const lyricsEl  = document.getElementById('lyrics');
const statusEl  = document.getElementById('status');

// Audio plays ONLY on the host device — never touched on participant side
const audio   = new Audio();
audio.preload = 'auto';

// =============================================================================
// Boot
// =============================================================================
async function init() {
  // SPA redirect: Cloudflare Pages / GitHub Pages 404.html encodes the
  // original path into ?p=  so index.html can restore it via replaceState.
  const params     = new URLSearchParams(location.search);
  const redirected = params.get('p');
  if (redirected) {
    history.replaceState(null, '', redirected);
  }

  const id = parseRoomFromPath();
  if (id) {
    await enterRoom(id);
  } else {
    homeView.hidden = false;
  }
}

function parseRoomFromPath() {
  const m = location.pathname.match(/\/room\/([a-z0-9]+)/i);
  return m ? m[1] : null;
}

// =============================================================================
// Create room
// =============================================================================
createBtn.addEventListener('click', async () => {
  createBtn.disabled    = true;
  createBtn.textContent = 'Creating…';
  try {
    const res = await fetch(`${WORKER_URL}/create`);
    if (!res.ok) throw new Error(`Server responded ${res.status}`);
    const { roomId: id } = await res.json();
    history.pushState(null, '', `/room/${id}`);
    await enterRoom(id);
  } catch (err) {
    createBtn.disabled    = false;
    createBtn.textContent = 'Create Room';
    setStatus('Could not reach server: ' + err.message);
  }
});

// =============================================================================
// Enter a room
// =============================================================================
async function enterRoom(id) {
  roomId = id;
  homeView.hidden = true;
  roomView.hidden = false;

  roomUrlEl.textContent = location.href;

  setStatus('Syncing clock…');
  await syncTime(id);

  setStatus('Loading lyrics…');
  await loadLyrics('test');

  setStatus('Connecting…');
  connectWS(id);
}

// =============================================================================
// NTP-style clock sync
// =============================================================================
async function syncTime(id) {
  const t0 = Date.now();
  const res = await fetch(`${WORKER_URL}/room/${id}/time`);
  const { serverTime } = await res.json();
  const t1 = Date.now();
  // Assume symmetric RTT; server time sits at the midpoint
  offset = serverTime - Math.round((t0 + t1) / 2);
}

function serverNow() {
  return Date.now() + offset;
}

// =============================================================================
// WebSocket
// =============================================================================
function connectWS(id) {
  const wsUrl = WORKER_URL.replace('https', 'wss').replace('http', 'ws')
              + '/room/' + id + '/ws';

  ws = new WebSocket(wsUrl);

  ws.addEventListener('open', () => {
    // Refine clock offset every 10 s while connected
    setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping', clientTime: Date.now() }));
      }
    }, 10_000);
  });

  ws.addEventListener('message', e => {
    try { onMessage(JSON.parse(e.data)); } catch { /* ignore bad frames */ }
  });

  ws.addEventListener('close', () => {
    setStatus('Disconnected – reconnecting…');
    setTimeout(() => connectWS(id), 2000);
  });

  ws.addEventListener('error', () => setStatus('WebSocket error.'));
}

// =============================================================================
// Message handler
// =============================================================================
function onMessage(msg) {
  switch (msg.type) {

    case 'joined':
      role   = msg.role;
      offset = msg.serverTime - Date.now(); // coarse initial offset
      if (role === 'host') {
        audio.src           = '/songs/test.mp3';
        playBtn.hidden      = false;
        playBtn.textContent = 'Play';
        setStatus('You are the host – press Play when ready.');
      } else {
        setStatus('Waiting for the host to start…');
      }
      break;

    case 'pong': {
      const rtt = Date.now() - msg.clientTime;
      offset = msg.serverTime - (msg.clientTime + Math.round(rtt / 2));
      break;
    }

    case 'play':
      beginPlayback(msg.startTime, msg.song);
      break;

    case 'stop':
      stopPlayback();
      break;

    case 'promoted':
      role                = 'host';
      audio.src           = '/songs/test.mp3';
      playBtn.hidden      = false;
      playBtn.textContent = 'Play';
      setStatus('You are now the host.');
      break;
  }
}

// =============================================================================
// Playback
// =============================================================================
playBtn.addEventListener('click', () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (!playing) {
    ws.send(JSON.stringify({ type: 'play', song: 'test' }));
  } else {
    ws.send(JSON.stringify({ type: 'stop' }));
  }
});

function beginPlayback(srvStart, song) {
  startTime = srvStart;
  playing   = true;

  // Audio only on host
  if (role === 'host') {
    const elapsed       = (serverNow() - startTime) / 1000;
    audio.currentTime   = Math.max(0, elapsed);
    audio.play().catch(() => {
      setStatus('Tap anywhere to allow audio playback.');
      document.addEventListener('click', () => audio.play(), { once: true });
    });
    playBtn.textContent = 'Stop';
  }

  setStatus('');
  startAnimation();
}

function stopPlayback() {
  playing   = false;
  startTime = null;

  if (role === 'host') {
    audio.pause();
    audio.currentTime   = 0;
    playBtn.textContent = 'Play';
    setStatus('Stopped – press Play to start again.');
  } else {
    setStatus('Waiting for the host to start…');
  }

  stopAnimation();
  clearHighlights();
}

// =============================================================================
// Lyrics
// =============================================================================
async function loadLyrics(song) {
  try {
    const res = await fetch(`/songs/${song}.json`);
    if (!res.ok) throw new Error(res.status);
    lyrics = await res.json();
    renderWords();
  } catch (err) {
    lyricsEl.textContent = '⚠ Could not load lyrics: ' + err.message;
  }
}

function renderWords() {
  lyricsEl.innerHTML = '';
  lyrics.forEach((entry, i) => {
    const span       = document.createElement('span');
    span.textContent = entry.word;
    span.className   = 'word';
    span.dataset.i   = i;
    lyricsEl.appendChild(span);
    lyricsEl.appendChild(document.createTextNode(' '));
  });
}

// =============================================================================
// Animation loop – highlights the current word every frame
// =============================================================================
function startAnimation() {
  stopAnimation();
  function tick() {
    if (!playing || startTime === null) return;
    highlight((serverNow() - startTime) / 1000);
    animFrame = requestAnimationFrame(tick);
  }
  animFrame = requestAnimationFrame(tick);
}

function stopAnimation() {
  if (animFrame !== null) {
    cancelAnimationFrame(animFrame);
    animFrame = null;
  }
}

function highlight(elapsed) {
  document.querySelectorAll('.word').forEach((span, i) => {
    const w        = lyrics[i];
    const isActive = elapsed >= w.start && elapsed < w.end;
    const isDone   = elapsed >= w.end;
    span.classList.toggle('active', isActive);
    span.classList.toggle('done',   isDone && !isActive);
  });
}

function clearHighlights() {
  document.querySelectorAll('.word').forEach(s => s.classList.remove('active', 'done'));
}

// =============================================================================
// Helpers
// =============================================================================
function setStatus(msg) {
  statusEl.textContent = msg;
}

// Click room-url box → copy to clipboard
document.addEventListener('click', e => {
  if (e.target.id !== 'room-url') return;
  navigator.clipboard.writeText(e.target.textContent).then(() => {
    const orig          = e.target.textContent;
    e.target.textContent = 'Copied!';
    setTimeout(() => { e.target.textContent = orig; }, 1500);
  });
});

// =============================================================================
init();
