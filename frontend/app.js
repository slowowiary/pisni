// =============================================================================
// Karaoke – frontend
// =============================================================================

// ── CONFIGURE THIS after deploying the worker ─────────────────────────────────
const WORKER_URL = 'https://karaoke-worker.YOUR-SUBDOMAIN.workers.dev';

// If your GitHub Pages site lives at  https://user.github.io/repo-name/
// set BASE_PATH to '/repo-name'.  For a custom domain leave it ''.
const BASE_PATH = '';
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

// ── State ────────────────────────────────────────────────────────────────────
let ws         = null;
let role       = null;   // 'host' | 'participant'
let offset     = 0;      // serverTime – clientTime  (ms)
let startTime  = null;   // server timestamp (ms) at which playback began
let playing    = false;
let lyrics     = [];     // [{ word, start, end }, ...]
let animFrame  = null;
let roomId     = null;

// ── DOM refs ─────────────────────────────────────────────────────────────────
const homeView      = document.getElementById('home-view');
const roomView      = document.getElementById('room-view');
const createBtn     = document.getElementById('create-btn');
const playBtn       = document.getElementById('play-btn');
const roomUrlEl     = document.getElementById('room-url');
const lyricsEl      = document.getElementById('lyrics');
const statusEl      = document.getElementById('status');

// Audio only ever plays on the host device
const audio = new Audio();
audio.preload = 'auto';

// =============================================================================
// Boot
// =============================================================================
async function init() {
  // GitHub-Pages SPA redirect: index.html?p=/room/abc  →  restore the path
  const params = new URLSearchParams(location.search);
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
  // Works with any base path prefix: /repo-name/room/abc
  const m = location.pathname.match(/\/room\/([a-z0-9]+)/i);
  return m ? m[1] : null;
}

// =============================================================================
// Create room
// =============================================================================
createBtn.addEventListener('click', async () => {
  createBtn.disabled     = true;
  createBtn.textContent  = 'Creating…';
  try {
    const res = await fetch(`${WORKER_URL}/create`);
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    history.pushState(null, '', `${BASE_PATH}/room/${data.roomId}`);
    await enterRoom(data.roomId);
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

  // Show the shareable link immediately
  roomUrlEl.textContent = location.href;

  setStatus('Syncing clock…');
  await syncTime(id);

  setStatus('Loading lyrics…');
  await loadLyrics('test');

  setStatus('Connecting…');
  connectWS(id);
}

// =============================================================================
// NTP-style clock sync  (HTTP round-trip before WebSocket opens)
// =============================================================================
async function syncTime(id) {
  const t0 = Date.now();
  const res = await fetch(`${WORKER_URL}/room/${id}/time`);
  const { serverTime } = await res.json();
  const t1 = Date.now();
  // Assume symmetric RTT; server time at the midpoint of the trip
  offset = serverTime - Math.round((t0 + t1) / 2);
}

function serverNow() {
  return Date.now() + offset;
}

// =============================================================================
// WebSocket connection
// =============================================================================
function connectWS(id) {
  const proto = WORKER_URL.startsWith('https') ? 'wss' : 'ws';
  const base  = WORKER_URL.replace(/^https?/, proto);
  ws = new WebSocket(`${base}/room/${id}/ws`);

  ws.addEventListener('open', () => {
    // Refine offset every 10 s while connected
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
        audio.src           = 'songs/test.mp3';
        playBtn.hidden      = false;
        playBtn.textContent = 'Play';
        setStatus('You are the host – press Play when ready.');
      } else {
        setStatus('Waiting for the host to start…');
      }
      break;

    case 'pong': {
      // Refine offset with RTT correction
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
      audio.src           = 'songs/test.mp3';
      playBtn.hidden      = false;
      playBtn.textContent = 'Play';
      setStatus('You are now the host.');
      break;
  }
}

// =============================================================================
// Playback control
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

  if (role === 'host') {
    // Seek to wherever we are in the song (handles late-joiners who become host)
    const elapsed = (serverNow() - startTime) / 1000;
    audio.currentTime = Math.max(0, elapsed);
    audio.play().catch(() => {
      setStatus('Click anywhere to allow audio playback.');
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
    audio.currentTime = 0;
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
    const res = await fetch(`songs/${song}.json`);
    lyrics = await res.json();
    renderWords();
  } catch {
    lyricsEl.textContent = '⚠ Could not load lyrics file.';
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
// Animation loop – highlights the current word
// =============================================================================
function startAnimation() {
  stopAnimation();
  function tick() {
    if (!playing || startTime === null) return;
    const elapsed = (serverNow() - startTime) / 1000;
    highlight(elapsed);
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
    const w = lyrics[i];
    const isActive = elapsed >= w.start && elapsed < w.end;
    const isDone   = elapsed >= w.end;
    span.classList.toggle('active', isActive);
    span.classList.toggle('done',   isDone && !isActive);
  });
}

function clearHighlights() {
  document.querySelectorAll('.word').forEach(span => {
    span.classList.remove('active', 'done');
  });
}

// =============================================================================
// Helpers
// =============================================================================
function setStatus(msg) {
  statusEl.textContent = msg;
}

// Copy room URL on click
document.addEventListener('click', e => {
  if (e.target.id === 'room-url') {
    navigator.clipboard.writeText(e.target.textContent).then(() => {
      e.target.dataset.orig = e.target.textContent;
      e.target.textContent  = 'Copied!';
      setTimeout(() => {
        e.target.textContent = e.target.dataset.orig;
      }, 1500);
    });
  }
});

// =============================================================================
init();
