// =============================================================================
// Karaoke – frontend
// =============================================================================
const WORKER_URL = 'https://pisni.slovo-wiry.workers.dev';
'use strict';

let ws = null, role = null, playing = false, paused = false;
let lyrics = [], animFrame = null, roomId = null;
let startTime = null, pauseTime = null;
let currentSong  = null;
let buffers      = {};    // { songName: AudioBuffer } — кеш буферів
let sourceNode   = null, audioCtx = null;
let syncAudioEnabled = false;
let myAudioEnabled   = false;
let audioReady       = false; // буфер поточної пісні готовий і AudioContext OK
let wakeLock         = null;
let songs            = [];    // список пісень з сервера

// DOM
const homeView     = document.getElementById('home-view');
const roomView     = document.getElementById('room-view');
const createBtn    = document.getElementById('create-btn');
const playBtn      = document.getElementById('play-btn');
const pauseBtn     = document.getElementById('pause-btn');
const syncLabel    = document.getElementById('sync-audio-label');
const syncCheck    = document.getElementById('sync-audio-check');
const myAudioLabel = document.getElementById('my-audio-label');
const myAudioCheck = document.getElementById('my-audio-check');
const songPicker   = document.getElementById('song-picker');
const songSelect   = document.getElementById('song-select');
const roomUrlEl    = document.getElementById('room-url');
const lyricsEl     = document.getElementById('lyrics');
const statusEl     = document.getElementById('status');

// =============================================================================
// AudioContext
// =============================================================================
function getCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

async function loadBuffer(song) {
  if (buffers[song]) return buffers[song];
  const res = await fetch('/songs/' + song + '.mp3');
  if (!res.ok) throw new Error('MP3 not found: ' + song);
  buffers[song] = await getCtx().decodeAudioData(await res.arrayBuffer());
  return buffers[song];
}

// =============================================================================
// Scheduled playback
// =============================================================================
function scheduleAudio() {
  const buf = buffers[currentSong];
  if (!buf || startTime === null) return;
  stopAudioNode();
  const ctx     = getCtx();
  const msUntil = startTime - serverNow();
  const elapsed = Math.max(0, -msUntil / 1000);
  const offset  = Math.min(elapsed, buf.duration - 0.01);
  if (offset >= buf.duration) return;
  const ctxWhen = Math.max(ctx.currentTime + 0.005, ctx.currentTime + msUntil / 1000);
  const src = ctx.createBufferSource();
  src.buffer      = buf;
  src._ctxWhen    = ctxWhen;
  src._songOffset = offset;
  src.connect(ctx.destination);
  src.start(ctxWhen, offset);
  sourceNode = src;
  // Коли пісня закінчилась — оновлюємо UI хоста
  src.onended = () => {
    if (sourceNode === src) {
      sourceNode = null;
      if (role === 'host' && playing) onSongEnded();
    }
  };
}

function stopAudioNode() {
  if (sourceNode) { try { sourceNode.stop(); } catch {} sourceNode = null; }
}

function currentPos() {
  if (!sourceNode || !audioCtx) return null;
  return sourceNode._songOffset + (audioCtx.currentTime - sourceNode._ctxWhen);
}

function onSongEnded() {
  // Пісня закінчилась на хості — скидаємо стан але не чіпаємо syncAudio
  playing = false; paused = false; startTime = null;
  playBtn.textContent = '▶ Play';
  pauseBtn.hidden = true;
  setStatus('Song ended. Select a song and press Play.');
  stopAnimation(); clearHighlights();
}

function resyncIfNeeded() {
  if (!playing || paused || startTime === null) return;
  if (!shouldPlayAudio() || !audioReady) return;
  const expected = (serverNow() - startTime) / 1000;
  const actual   = currentPos();
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
// Clock sync
// =============================================================================
let clockSamples = [], offset = 0;
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
  for (let i = 0; i < 12; i++) {
    const t0  = Date.now();
    const res = await fetch(`${WORKER_URL}/room/${id}/time`);
    addSample((await res.json()).serverTime, t0);
    if (i < 11) await new Promise(r => setTimeout(r, 15));
  }
}

// =============================================================================
// Song list
// =============================================================================
async function loadSongList() {
  try {
    const res = await fetch(WORKER_URL + '/api/songs');
    if (res.ok) {
      songs = await res.json();
    } else {
      songs = ['test'];
    }
  } catch { songs = ['test']; }
}

function populateSongSelect() {
  songSelect.innerHTML = '';
  for (const s of songs) {
    const opt = document.createElement('option');
    opt.value       = s;
    opt.textContent = s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    songSelect.appendChild(opt);
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
  await loadSongList();
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
  setStatus('Loading lyrics…');
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
    }, 8000);
  });
  ws.addEventListener('message', e => { try { onMessage(JSON.parse(e.data)); } catch(err) { console.error('onMessage error:', err); } });
  ws.addEventListener('close',   () => { setStatus('Reconnecting…'); setTimeout(() => connectWS(id), 2000); });
  ws.addEventListener('error',   () => setStatus('WebSocket error.'));
}

// =============================================================================
// Toggle UI helper
// =============================================================================
function setToggle(label, check, on) {
  check.checked = on;
  label.classList.toggle('on', on);
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
        if (songPicker) { populateSongSelect(); songPicker.hidden = false; }
        playBtn.hidden      = false;
        syncLabel.hidden    = false;
        myAudioLabel.hidden = true;
        setStatus('You are the host.');
        // Хост завантажує буфер першої пісні
        currentSong = songSelect.value;
        getCtx();
        loadBuffer(currentSong).then(() => { audioReady = true; }).catch(() => {});
      } else {
        songPicker.hidden   = true;
        playBtn.hidden      = true;
        pauseBtn.hidden     = true;
        syncLabel.hidden    = true;
        myAudioLabel.hidden = true;
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
      handleSongChange(msg.song);
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
          myAudioLabel.hidden = false;
          // Не скидаємо myAudioEnabled — учасник зберігає своє рішення між піснями
          if (myAudioEnabled && audioReady && playing && !paused && startTime !== null) {
            scheduleAudio();
          }
          if (!myAudioEnabled) setStatus('Enable audio on your device 👇');
        } else {
          myAudioLabel.hidden = true;
          stopAudioNode();
          setStatus(playing ? '' : 'Waiting for host…');
        }
      }
      break;

    case 'promoted':
      role = 'host';
      populateSongSelect();
      songPicker.hidden   = false;
      playBtn.hidden      = false;
      syncLabel.hidden    = false;
      myAudioLabel.hidden = true;
      setStatus('You are now the host.');
      getCtx();
      currentSong = songSelect.value;
      loadBuffer(currentSong).then(() => { audioReady = true; }).catch(() => {});
      break;
  }
}

// Якщо пісня змінилась — завантажуємо новий текст
async function handleSongChange(song) {
  if (song === currentSong) return;
  currentSong = song;
  if (role === 'host' && songSelect) {
    songSelect.value = song;
  }
  await loadLyrics(song);
  // Якщо учасник з увімкненим аудіо — підвантажуємо буфер
  if (role !== 'host' && myAudioEnabled && syncAudioEnabled) {
    loadBuffer(song).then(() => { audioReady = true; }).catch(() => {});
  }
}

// =============================================================================
// Host controls
// =============================================================================
playBtn.addEventListener('click', () => {
  if (!ws || ws.readyState !== WebSocket.OPEN || role !== 'host') return;
  getCtx();
  if (!playing) {
    const song = songSelect ? songSelect.value : (currentSong || 'test');
    ws.send(JSON.stringify({ type: 'play', song }));
  } else {
    ws.send(JSON.stringify({ type: 'stop' }));
  }
});

pauseBtn.addEventListener('click', () => {
  if (!ws || ws.readyState !== WebSocket.OPEN || role !== 'host' || !playing) return;
  ws.send(JSON.stringify({ type: paused ? 'resume' : 'pause', song: currentSong }));
});

syncCheck.addEventListener('change', () => {
  getCtx();
  setToggle(syncLabel, syncCheck, syncCheck.checked);
  if (role === 'host' && ws && ws.readyState === WebSocket.OPEN)
    ws.send(JSON.stringify({ type: 'sync_audio', enabled: syncCheck.checked }));
});

// Вибір пісні хостом — завантажуємо буфер заздалегідь
if (songSelect) songSelect.addEventListener('change', () => {
  const song = songSelect.value;
  if (song !== currentSong) {
    currentSong = song;
    loadLyrics(song);
    getCtx();
    loadBuffer(song).then(() => { audioReady = true; }).catch(() => {});
  }
});

// Учасник: натиск = user gesture → розблок AudioContext → завантаження буферу
myAudioCheck.addEventListener('change', async () => {
  myAudioEnabled = myAudioCheck.checked;
  setToggle(myAudioLabel, myAudioCheck, myAudioEnabled);
  if (myAudioEnabled) {
    getCtx(); // user gesture — розблоковуємо
    setStatus('⏳ Loading audio…');
    try {
      await loadBuffer(currentSong || 'test');
      audioReady = true;
      setStatus(playing ? '' : '✅ Ready! Waiting for host to play…');
      if (playing && !paused && startTime !== null) scheduleAudio();
    } catch (err) {
      setStatus('⚠ ' + err.message);
      myAudioEnabled = false;
      setToggle(myAudioLabel, myAudioCheck, false);
    }
  } else {
    audioReady = false;
    stopAudioNode();
    // Буфер НЕ видаляємо — якщо знову ввімкне, не треба перезавантажувати
    setStatus(playing ? '' : 'Enable audio on your device 👇');
  }
});

// =============================================================================
// Playback
// =============================================================================
async function onPlay(song) {
  playing = true; paused = false;
  requestWakeLock();
  if (role === 'host') {
    playBtn.textContent  = '⏹ Stop';
    pauseBtn.hidden      = false;
    pauseBtn.textContent = '⏸ Pause';
  }
  await loadLyrics(song);
  setStatus('');
  startAnimation();

  if (role === 'host') {
    if (!buffers[song]) {
      try { await loadBuffer(song); audioReady = true; } catch (err) { setStatus('⚠ ' + err.message); return; }
    }
    scheduleAudio();
  } else if (syncAudioEnabled && myAudioEnabled && audioReady) {
    scheduleAudio();
  }
}

function onPause() {
  paused = true; stopAudioNode(); stopAnimation();
  if (role === 'host') { pauseBtn.textContent = '▶ Resume'; setStatus('Paused.'); }
  else setStatus('Paused by host…');
}

async function onResume(song) {
  paused = false; setStatus(''); startAnimation(); requestWakeLock();
  if (role === 'host') {
    pauseBtn.textContent = '⏸ Pause';
    scheduleAudio();
  } else if (syncAudioEnabled && myAudioEnabled && audioReady) {
    scheduleAudio();
  }
}

function onStop() {
  playing = false; paused = false; startTime = null; pauseTime = null;
  stopAudioNode(); releaseWakeLock();
  stopAnimation(); clearHighlights();

  if (role === 'host') {
    playBtn.textContent = '▶ Play';
    pauseBtn.hidden     = true;
    // Хост тримає буфер і audioReady — syncAudio НЕ скидаємо
    setStatus('Stopped. Select a song and press Play.');
  } else {
    // Учасник: зберігаємо myAudioEnabled і буфер — не скидаємо!
    // syncAudio скидається тільки якщо хост явно вимкнув галочку
    audioReady = false; // після stop треба знову спланувати
    setStatus(myAudioEnabled ? '✅ Ready for next song…' : 'Waiting for host…');
  }
}

// =============================================================================
// Lyrics
// =============================================================================
async function loadLyrics(song) {
  try {
    const res = await fetch('/songs/' + song + '.json');
    if (!res.ok) { lyricsEl.innerHTML = ''; return; }
    lyrics = await res.json(); renderWords();
  } catch { lyricsEl.innerHTML = ''; }
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
