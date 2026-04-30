// =============================================================================
// Karaoke – frontend
// =============================================================================
const WORKER_URL = 'https://pisni.slovo-wiry.workers.dev';
'use strict';

let ws = null, role = null, playing = false, paused = false;
let lyrics = [], animFrame = null, roomId = null;
let startTime = null, pauseTime = null;
let songBuffer = null, sourceNode = null, audioCtx = null;
let syncAudioEnabled = false;
let myAudioEnabled   = false; // стає true коли учасник ставить галочку
let audioReady       = false; // буфер завантажений і AudioContext розблокований
let wakeLock         = null;

// DOM
const homeView     = document.getElementById('home-view');
const roomView     = document.getElementById('room-view');
const createBtn    = document.getElementById('create-btn');
const playBtn      = document.getElementById('play-btn');
const pauseBtn     = document.getElementById('pause-btn');
const syncCheck    = document.getElementById('sync-audio-check');
const syncLabel    = document.getElementById('sync-audio-label');
const myAudioCheck = document.getElementById('my-audio-check');
const myAudioLabel = document.getElementById('my-audio-label');
const roomUrlEl    = document.getElementById('room-url');
const lyricsEl     = document.getElementById('lyrics');
const statusEl     = document.getElementById('status');
const readyBadge   = document.getElementById('ready-badge');

// Clock — зберігаємо багато зразків для максимальної точності
let clockSamples = [], offset = 0;

// =============================================================================
// AudioContext
// =============================================================================
function getCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

// Викликається при user gesture (натиск галочки)
async function unlockAndLoad(song) {
  getCtx(); // розблоковуємо AudioContext цим самим жестом
  setStatus('⏳ Loading audio…');
  try {
    await loadSongBuffer(song);
    audioReady = true;
    setStatus('✅ Ready! Waiting for host to start…');
    readyBadge.hidden = false;
  } catch (err) {
    setStatus('⚠ Could not load audio: ' + err.message);
  }
}

async function loadSongBuffer(song) {
  if (songBuffer) return songBuffer;
  const res = await fetch('/songs/' + song + '.mp3');
  if (!res.ok) throw new Error('MP3 not found');
  songBuffer = await getCtx().decodeAudioData(await res.arrayBuffer());
  return songBuffer;
}

// =============================================================================
// Scheduled playback — серцевина синхронізації
//
// Формула: src.start(ctx.currentTime + msUntilStart/1000, songOffset)
// AudioContext виконує старт з апаратною точністю (~sample = 0.02ms @ 44100Hz)
// =============================================================================
function scheduleAudio() {
  if (!songBuffer || startTime === null) return;
  stopAudioNode();
  const ctx = getCtx();

  const msUntil    = startTime - serverNow();
  const elapsed    = Math.max(0, -msUntil / 1000);
  const songOffset = Math.min(elapsed, songBuffer.duration - 0.01);

  if (songOffset >= songBuffer.duration) return;

  // Якщо старт в майбутньому — плануємо точно
  // Якщо вже в минулому — стартуємо з правильної позиції негайно
  const ctxWhen = Math.max(ctx.currentTime + 0.005, ctx.currentTime + msUntil / 1000);

  const src = ctx.createBufferSource();
  src.buffer      = songBuffer;
  src._ctxWhen    = ctxWhen;
  src._songOffset = songOffset;
  src.connect(ctx.destination);
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
  if (!shouldPlayAudio() || !audioReady) return;
  const expected = (serverNow() - startTime) / 1000;
  const actual   = currentSongPos();
  if (actual === null) { scheduleAudio(); return; }
  if (Math.abs(actual - expected) > 0.05) scheduleAudio();
}

function shouldPlayAudio() {
  if (role === 'host') return true;
  return syncAudioEnabled && myAudioEnabled && audioReady;
}

// =============================================================================
// Wake Lock
// =============================================================================
async function requestWakeLock() {
  if ('wakeLock' in navigator) {
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch {}
  }
}
function releaseWakeLock() { if (wakeLock) { wakeLock.release(); wakeLock = null; } }
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && playing && !paused) requestWakeLock();
});

// =============================================================================
// Clock sync — зважена медіана, відкидаємо 30% найповільніших
// =============================================================================
function serverNow() { return Date.now() + offset; }

function addSample(serverTime, t0) {
  const rtt = Date.now() - t0;
  clockSamples.push({ offset: serverTime - (t0 + rtt / 2), rtt });
  if (clockSamples.length > 16) clockSamples.shift();
  const sorted  = [...clockSamples].sort((a, b) => a.rtt - b.rtt);
  const trimmed = sorted.slice(0, Math.max(1, Math.floor(sorted.length * 0.7)));
  const min = trimmed[0].rtt;
  let ws = 0, os = 0;
  for (const s of trimmed) { const w = min / s.rtt; ws += w; os += s.offset * w; }
  offset = os / ws;
}

async function syncTime(id) {
  // 12 замірів при вході для максимальної початкової точності
  for (let i = 0; i < 12; i++) {
    const t0  = Date.now();
    const res = await fetch(`${WORKER_URL}/room/${id}/time`);
    addSample((await res.json()).serverTime, t0);
    if (i < 11) await new Promise(r => setTimeout(r, 15));
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
    // Ping кожні 8 секунд — тільки для підтримки offset актуальним
    setInterval(() => {
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: 'ping', clientTime: Date.now() }));
    }, 8000);
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
        playBtn.hidden      = false;
        syncLabel.hidden    = false;
        myAudioLabel.hidden = true;
        readyBadge.hidden   = true;
        setStatus('You are the host.');
        // Хост завжди завантажує буфер заздалегідь
        getCtx();
        loadSongBuffer('test').then(() => { audioReady = true; }).catch(() => {});
      } else {
        playBtn.hidden      = true;
        pauseBtn.hidden     = true;
        syncLabel.hidden    = true;
        myAudioLabel.hidden = true;
        readyBadge.hidden   = true;
        setStatus('Waiting for host…');
      }
      break;

    case 'pong':
      addSample(msg.serverTime, msg.clientTime);
      resyncIfNeeded();
      break;

    case 'play':
      startTime        = msg.startTime;
      pauseTime        = null; paused = false;
      syncAudioEnabled = msg.syncAudio || false;
      onPlay(msg.song);
      break;

    case 'pause':
      pauseTime = msg.pauseTime;
      onPause();
      break;

    case 'resume':
      startTime        = msg.startTime;
      pauseTime        = null; paused = false;
      syncAudioEnabled = msg.syncAudio || false;
      onResume(msg.song);
      break;

    case 'stop':
      onStop();
      break;

    case 'sync_audio':
      syncAudioEnabled = msg.enabled;
      if (role !== 'host') {
        if (msg.enabled) {
          // Показуємо особисту галочку — натиск на неї = user gesture + завантаження
          myAudioLabel.hidden = false;
          setStatus('Enable audio on your device to participate 👇');
        } else {
          myAudioLabel.hidden = true;
          myAudioEnabled      = false;
          myAudioCheck.checked = false;
          audioReady          = false;
          readyBadge.hidden   = true;
          stopAudioNode();
          songBuffer = null;
          setStatus('Waiting for host…');
        }
      }
      break;

    case 'promoted':
      role = 'host';
      playBtn.hidden      = false;
      syncLabel.hidden    = false;
      myAudioLabel.hidden = true;
      readyBadge.hidden   = true;
      setStatus('You are now the host.');
      getCtx();
      loadSongBuffer('test').then(() => { audioReady = true; }).catch(() => {});
      break;
  }
}

// =============================================================================
// Host controls
// =============================================================================
playBtn.addEventListener('click', () => {
  if (!ws || ws.readyState !== WebSocket.OPEN || role !== 'host') return;
  getCtx();
  ws.send(JSON.stringify({ type: playing ? 'stop' : 'play', song: 'test' }));
});

pauseBtn.addEventListener('click', () => {
  if (!ws || ws.readyState !== WebSocket.OPEN || role !== 'host' || !playing) return;
  ws.send(JSON.stringify({ type: paused ? 'resume' : 'pause', song: 'test' }));
});

syncCheck.addEventListener('change', () => {
  getCtx();
  if (role === 'host' && ws && ws.readyState === WebSocket.OPEN)
    ws.send(JSON.stringify({ type: 'sync_audio', enabled: syncCheck.checked }));
});

// Учасник: натиск галочки = user gesture → розблоковує AudioContext → завантажує буфер
myAudioCheck.addEventListener('change', async () => {
  myAudioEnabled = myAudioCheck.checked;
  if (myAudioEnabled) {
    // ЦЕ user gesture — тут AudioContext гарантовано розблокується
    await unlockAndLoad('test');
    // Якщо вже грає — стартуємо одразу
    if (playing && !paused && startTime !== null && audioReady) {
      scheduleAudio();
    }
  } else {
    audioReady = false;
    readyBadge.hidden = true;
    stopAudioNode();
    songBuffer = null;
    setStatus('Enable audio on your device to participate 👇');
  }
});

// =============================================================================
// Playback
// =============================================================================
async function onPlay(song) {
  playing = true; paused = false;
  requestWakeLock();
  if (role === 'host') {
    playBtn.textContent  = 'Stop';
    pauseBtn.hidden      = false;
    pauseBtn.textContent = 'Pause';
  }
  setStatus('');
  startAnimation();

  if (role === 'host') {
    // Буфер вже завантажений — просто плануємо
    if (audioReady && songBuffer) {
      scheduleAudio();
    } else {
      try { await loadSongBuffer(song); audioReady = true; scheduleAudio(); }
      catch (err) { setStatus('⚠ ' + err.message); }
    }
  } else if (syncAudioEnabled && myAudioEnabled && audioReady) {
    // Буфер вже завантажений заздалегідь — стартуємо точно по startTime
    scheduleAudio();
  }
}

function onPause() {
  paused = true;
  stopAudioNode();
  stopAnimation();
  if (role === 'host') { pauseBtn.textContent = 'Resume'; setStatus('Paused.'); }
  else setStatus('Paused by host…');
}

async function onResume(song) {
  paused = false;
  setStatus(''); startAnimation(); requestWakeLock();
  if (role === 'host') {
    pauseBtn.textContent = 'Pause';
    scheduleAudio();
  } else if (syncAudioEnabled && myAudioEnabled && audioReady) {
    scheduleAudio();
  }
}

function onStop() {
  playing = false; paused = false; startTime = null; pauseTime = null;
  syncAudioEnabled = false;
  stopAudioNode();
  audioReady = false;
  releaseWakeLock();
  if (role !== 'host') {
    songBuffer = null;
    myAudioEnabled       = false;
    myAudioCheck.checked = false;
    myAudioLabel.hidden  = true;
    readyBadge.hidden    = true;
  }
  if (role === 'host') {
    playBtn.textContent = 'Play';
    pauseBtn.hidden     = true;
    // Хост тримає буфер для наступного play
    loadSongBuffer('test').then(() => { audioReady = true; }).catch(() => {});
    setStatus('Stopped.');
  } else {
    setStatus('Waiting for host…');
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
