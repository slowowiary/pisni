// =============================================================================
// Karaoke – frontend
// =============================================================================
const WORKER_URL = 'https://pisni.slovo-wiry.workers.dev';
'use strict';

let ws = null, role = null, playing = false, paused = false;
let lyrics = [], animFrame = null, roomId = null;
let startTime = null;    // серверний ms старту
let pauseTime = null;    // серверний ms паузи
let songBuffer = null, sourceNode = null, audioCtx = null;

// Clock
let clockSamples = [], offset = 0;

// DOM
const homeView       = document.getElementById('home-view');
const roomView       = document.getElementById('room-view');
const createBtn      = document.getElementById('create-btn');
const playBtn        = document.getElementById('play-btn');
const pauseBtn       = document.getElementById('pause-btn');
const syncCheck      = document.getElementById('sync-audio-check');
const syncLabel      = document.getElementById('sync-audio-label');
const roomUrlEl      = document.getElementById('room-url');
const lyricsEl       = document.getElementById('lyrics');
const statusEl       = document.getElementById('status');

// =============================================================================
// AudioContext
// =============================================================================
function getCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

async function loadSongBuffer(song) {
  if (songBuffer) return songBuffer;
  const res = await fetch('/songs/' + song + '.mp3');
  if (!res.ok) throw new Error('MP3 not found');
  songBuffer = await getCtx().decodeAudioData(await res.arrayBuffer());
  return songBuffer;
}

// =============================================================================
// Scheduled playback
// =============================================================================
function scheduleAudio(fromPause = false) {
  if (!songBuffer || startTime === null) return;
  stopAudioNode();
  const ctx = getCtx();

  // Скільки секунд вже зіграло до паузи (або від старту)
  const alreadyPlayed = fromPause && pauseTime !== null
    ? (pauseTime - startTime) / 1000
    : (serverNow() - startTime) / 1000;

  const songOffset = Math.max(0, Math.min(alreadyPlayed, songBuffer.duration - 0.01));

  // Якщо startTime в майбутньому — плануємо точно
  const msUntil = startTime - serverNow();
  const ctxWhen = msUntil > 0
    ? ctx.currentTime + msUntil / 1000
    : ctx.currentTime + 0.005;

  const src = ctx.createBufferSource();
  src.buffer = songBuffer;
  src.connect(ctx.destination);
  src._ctxWhen    = ctxWhen;
  src._songOffset = songOffset;
  src.start(ctxWhen, songOffset);
  sourceNode = src;
  src.onended = () => { if (sourceNode === src) sourceNode = null; };
}

function stopAudioNode() {
  if (sourceNode) { try { sourceNode.stop(); } catch {} sourceNode = null; }
}

function currentSongPos() {
  if (!sourceNode || !audioCtx) return null;
  return sourceNode._songOffset + (audioCtx.currentTime - sourceNode._ctxWhen);
}

function resyncIfNeeded() {
  if (!playing || paused || startTime === null || !songBuffer) return;
  if (role !== 'host' && !syncCheck.checked) return;
  const expected = (serverNow() - startTime) / 1000;
  const actual   = currentSongPos();
  if (actual === null) { scheduleAudio(); return; }
  if (Math.abs(actual - expected) > 0.04) scheduleAudio(); // 40ms поріг
}

// =============================================================================
// Clock sync — зважена медіана, відкидаємо викиди
// =============================================================================
function serverNow() { return Date.now() + offset; }

function addSample(serverTime, t0) {
  const rtt = Date.now() - t0;
  clockSamples.push({ offset: serverTime - (t0 + rtt / 2), rtt });
  if (clockSamples.length > 12) clockSamples.shift();
  const sorted  = [...clockSamples].sort((a, b) => a.rtt - b.rtt);
  const trimmed = sorted.slice(0, Math.max(1, Math.floor(sorted.length * 0.7)));
  const min = trimmed[0].rtt;
  let ws = 0, os = 0;
  for (const s of trimmed) { const w = min / s.rtt; ws += w; os += s.offset * w; }
  offset = os / ws;
}

async function syncTime(id) {
  for (let i = 0; i < 10; i++) {
    const t0  = Date.now();
    const res = await fetch(`${WORKER_URL}/room/${id}/time`);
    addSample((await res.json()).serverTime, t0);
    if (i < 9) await new Promise(r => setTimeout(r, 20));
  }
}

// =============================================================================
// Identity
// =============================================================================
function getMyClientId() {
  let id = localStorage.getItem('karaoke_client_id');
  if (!id) { id = crypto.randomUUID(); localStorage.setItem('karaoke_client_id', id); }
  return id;
}

// =============================================================================
// Boot
// =============================================================================
async function init() {
  const p = new URLSearchParams(location.search).get('p');
  if (p) history.replaceState(null, '', p);
  const id = parseRoomFromPath();
  if (id) await enterRoom(id); else homeView.hidden = false;
}
function parseRoomFromPath() {
  const m = location.pathname.match(/\/room\/([a-z0-9]+)/i);
  return m ? m[1] : null;
}

// =============================================================================
// Create room
// =============================================================================
createBtn.addEventListener('click', async () => {
  createBtn.disabled = true; createBtn.textContent = 'Creating…';
  try {
    const clientId = crypto.randomUUID();
    localStorage.setItem('karaoke_client_id', clientId);
    const res = await fetch(`${WORKER_URL}/create?clientId=${encodeURIComponent(clientId)}`);
    if (!res.ok) throw new Error(res.status);
    const { roomId: id } = await res.json();
    history.pushState(null, '', '/room/' + id);
    await enterRoom(id);
  } catch (err) {
    createBtn.disabled = false; createBtn.textContent = 'Create Room';
    setStatus('Error: ' + err.message);
  }
});

// =============================================================================
// Enter room
// =============================================================================
async function enterRoom(id) {
  roomId = id;
  homeView.hidden = true; roomView.hidden = false;
  roomUrlEl.textContent = location.href;
  setStatus('Syncing clock…'); await syncTime(id);
  setStatus('Loading lyrics…'); await loadLyrics('test');
  setStatus('Connecting…'); connectWS(id);
}

// =============================================================================
// WebSocket
// =============================================================================
function connectWS(id) {
  const url = WORKER_URL.replace('https','wss').replace('http','ws') + '/room/' + id + '/ws';
  ws = new WebSocket(url);
  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'hello', clientId: getMyClientId() }));
    setInterval(() => {
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: 'ping', clientTime: Date.now() }));
    }, 1500);
  });
  ws.addEventListener('message', e => { try { onMessage(JSON.parse(e.data)); } catch {} });
  ws.addEventListener('close',   () => { setStatus('Reconnecting…'); setTimeout(() => connectWS(id), 2000); });
  ws.addEventListener('error',   () => setStatus('WebSocket error.'));
}

// =============================================================================
// Messages
// =============================================================================
function onMessage(msg) {
  switch (msg.type) {
    case 'joined':
      role = msg.role;
      addSample(msg.serverTime, Date.now() - 50);
      if (role === 'host') {
        playBtn.hidden  = false;
        syncLabel.hidden = false;
        setStatus('You are the host.');
        loadSongBuffer('test').catch(() => {});
      } else {
        // Учасники бачать тільки статус, без кнопок управління
        playBtn.hidden  = true;
        pauseBtn.hidden = true;
        syncLabel.hidden = true;
        setStatus('Waiting for the host to start…');
      }
      break;

    case 'pong':
      addSample(msg.serverTime, msg.clientTime);
      resyncIfNeeded();
      break;

    case 'play':
      startTime = msg.startTime;
      pauseTime = null;
      paused    = false;
      onPlay(msg.song);
      break;

    case 'pause':
      pauseTime = msg.pauseTime;
      onPause();
      break;

    case 'resume':
      startTime = msg.startTime; // новий startTime з урахуванням паузи
      pauseTime = null;
      paused    = false;
      onResume(msg.song);
      break;

    case 'stop':
      onStop();
      break;

    case 'sync_audio':
      // Хост транслює зміну галочки всім учасникам
      if (role !== 'host') {
        if (msg.enabled && playing && !paused) {
          getCtx();
          loadSongBuffer('test').then(scheduleAudio).catch(console.error);
        } else if (!msg.enabled) {
          stopAudioNode();
        }
      }
      break;

    case 'promoted':
      role = 'host';
      playBtn.hidden  = false;
      syncLabel.hidden = false;
      setStatus('You are now the host.');
      loadSongBuffer('test').catch(() => {});
      break;
  }
}

// =============================================================================
// Host controls
// =============================================================================
playBtn.addEventListener('click', () => {
  if (!ws || ws.readyState !== WebSocket.OPEN || role !== 'host') return;
  getCtx();
  if (!playing) {
    ws.send(JSON.stringify({ type: 'play', song: 'test' }));
  } else {
    ws.send(JSON.stringify({ type: 'stop' }));
  }
});

pauseBtn.addEventListener('click', () => {
  if (!ws || ws.readyState !== WebSocket.OPEN || role !== 'host') return;
  if (!playing) return;
  if (!paused) {
    ws.send(JSON.stringify({ type: 'pause' }));
  } else {
    ws.send(JSON.stringify({ type: 'resume', song: 'test' }));
  }
});

// Хост змінює галочку → транслюємо всім
syncCheck.addEventListener('change', () => {
  getCtx();
  if (role === 'host' && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'sync_audio', enabled: syncCheck.checked }));
  }
  // Сам хост музику завжди грає (незалежно від галочки)
});

// =============================================================================
// Playback handlers
// =============================================================================
async function onPlay(song) {
  playing = true; paused = false;
  if (role === 'host') {
    playBtn.textContent  = 'Stop';
    pauseBtn.hidden      = false;
    pauseBtn.textContent = 'Pause';
  }
  setStatus('');
  startAnimation();
  // Хост завжди грає; учасники — тільки якщо галочка (транслюється через sync_audio)
  if (role === 'host') {
    getCtx();
    try { await loadSongBuffer(song); scheduleAudio(); }
    catch (err) { setStatus('⚠ ' + err.message); }
  }
}

function onPause() {
  paused = true;
  stopAudioNode();
  stopAnimation();
  if (role === 'host') {
    pauseBtn.textContent = 'Resume';
    setStatus('Paused.');
  } else {
    setStatus('Paused by host…');
  }
}

async function onResume(song) {
  paused = false;
  if (role === 'host') {
    pauseBtn.textContent = 'Pause';
    setStatus('');
    getCtx();
    try { await loadSongBuffer(song); scheduleAudio(); }
    catch (err) { setStatus('⚠ ' + err.message); }
  } else if (syncCheck.checked) {
    getCtx();
    try { await loadSongBuffer(song); scheduleAudio(); }
    catch (err) {}
  }
  setStatus('');
  startAnimation();
}

function onStop() {
  playing = false; paused = false; startTime = null; pauseTime = null;
  stopAudioNode(); songBuffer = null;
  if (role === 'host') {
    playBtn.textContent = 'Play';
    pauseBtn.hidden     = true;
    setStatus('Stopped.');
  } else {
    setStatus('Waiting for the host to start…');
  }
  stopAnimation(); clearHighlights();
}

// =============================================================================
// Lyrics
// =============================================================================
async function loadLyrics(song) {
  try {
    const res = await fetch('/songs/' + song + '.json');
    if (!res.ok) throw new Error(res.status);
    lyrics = await res.json(); renderWords();
  } catch (err) { lyricsEl.textContent = '⚠ ' + err.message; }
}
function renderWords() {
  lyricsEl.innerHTML = '';
  lyrics.forEach((e, i) => {
    const s = document.createElement('span');
    s.textContent = e.word; s.className = 'word'; s.dataset.i = i;
    lyricsEl.appendChild(s); lyricsEl.appendChild(document.createTextNode(' '));
  });
}

// =============================================================================
// Animation
// =============================================================================
function startAnimation() {
  stopAnimation();
  (function tick() {
    if (!playing || paused || startTime === null) return;
    highlight((serverNow() - startTime) / 1000);
    animFrame = requestAnimationFrame(tick);
  })();
}
function stopAnimation() { if (animFrame) { cancelAnimationFrame(animFrame); animFrame = null; } }
function highlight(t) {
  document.querySelectorAll('.word').forEach((s, i) => {
    const w = lyrics[i];
    s.classList.toggle('active', t >= w.start && t < w.end);
    s.classList.toggle('done',   t >= w.end);
  });
}
function clearHighlights() {
  document.querySelectorAll('.word').forEach(s => s.classList.remove('active','done'));
}
function setStatus(m) { statusEl.textContent = m; }

document.addEventListener('click', e => {
  if (e.target.id !== 'room-url') return;
  navigator.clipboard.writeText(e.target.textContent).then(() => {
    const o = e.target.textContent; e.target.textContent = 'Copied!';
    setTimeout(() => { e.target.textContent = o; }, 1500);
  });
});

init();
