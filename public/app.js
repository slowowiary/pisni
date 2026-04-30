// =============================================================================
// Karaoke – frontend
// =============================================================================
const WORKER_URL = 'https://pisni.slovo-wiry.workers.dev';
'use strict';

let ws = null, role = null, playing = false, paused = false;
let lyrics = [], animFrame = null, roomId = null;
let startTime = null, pauseTime = null;
let currentSong  = null;
let buffers      = {};
let sourceNode   = null, audioCtx = null, gainNode = null;
let syncAudioEnabled = false;
let audioUnlocked    = false; // AudioContext розблокований user gesture
let audioReady       = false; // буфер завантажений
let isMuted          = false;
let wakeLock         = null;
let songs            = [];
let scrollAnimFrame  = null;
let currentScrollY   = 0;
let targetScrollY    = 0;

// DOM
const homeView        = document.getElementById('home-view');
const joinScreen      = document.getElementById('join-screen');
const joinBtn         = document.getElementById('join-btn');
const roomView        = document.getElementById('room-view');
const createBtn       = document.getElementById('create-btn');
const playBtn         = document.getElementById('play-btn');
const pauseBtn        = document.getElementById('pause-btn');
const syncLabel       = document.getElementById('sync-audio-label');
const syncCheck       = document.getElementById('sync-audio-check');
const headerToggle    = document.getElementById('header-audio-toggle');
const songPicker      = document.getElementById('song-picker');
const songList        = document.getElementById('song-list');
const lyricsContainer = document.getElementById('lyrics-container');
const lyricsEl        = document.getElementById('lyrics');
const roomUrlEl       = document.getElementById('room-url');
const statusEl        = document.getElementById('status');

// =============================================================================
// AudioContext — iOS вимагає створення і resume в user gesture
// =============================================================================
function unlockAudio() {
  // iOS Safari вимагає: створити AudioContext + програти тихий звук
  // в ТОМУ САМОМУ обробнику кліку
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    gainNode  = audioCtx.createGain();
    gainNode.gain.value = isMuted ? 0 : 1;
    gainNode.connect(audioCtx.destination);
  }
  // Програємо 0.001с порожній буфер — це розблоковує iOS
  const silentBuf = audioCtx.createBuffer(1, 1, 22050);
  const silent    = audioCtx.createBufferSource();
  silent.buffer   = silentBuf;
  silent.connect(audioCtx.destination);
  silent.start(0);
  if (audioCtx.state === 'suspended') audioCtx.resume();
  audioUnlocked = true;
}

function getCtx() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    gainNode  = audioCtx.createGain();
    gainNode.gain.value = isMuted ? 0 : 1;
    gainNode.connect(audioCtx.destination);
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

async function loadBuffer(song) {
  if (buffers[song]) return buffers[song];
  getCtx();
  const res = await fetch('/songs/' + song + '.mp3');
  if (!res.ok) throw new Error('MP3 not found');
  const arrayBuf = await res.arrayBuffer();
  // iOS Safari: decodeAudioData може не підтримувати Promise — обгортаємо
  buffers[song] = await new Promise((resolve, reject) => {
    audioCtx.decodeAudioData(arrayBuf, resolve, reject);
  });
  return buffers[song];
}

// =============================================================================
// Playback
// =============================================================================
async function scheduleAudio() {
  const buf = buffers[currentSong];
  if (!buf || startTime === null || !audioCtx) return;
  stopAudioNode();
  // iOS: чекаємо поки AudioContext відновиться
  if (audioCtx.state !== 'running') {
    try {
      await audioCtx.resume();
      // Додаткова пауза для iOS щоб контекст повністю активувався
      await new Promise(r => setTimeout(r, 50));
    } catch {}
  }
  // Перераховуємо після resume (пройшов час)
  const msUntil = startTime - serverNow();
  const elapsed = Math.max(0, -msUntil / 1000);
  const off     = Math.min(elapsed, buf.duration - 0.01);
  if (off >= buf.duration) return;
  const ctxWhen = Math.max(audioCtx.currentTime + 0.005,
                           audioCtx.currentTime + msUntil / 1000);
  const src = audioCtx.createBufferSource();
  src.buffer      = buf;
  src._ctxWhen    = ctxWhen;
  src._songOffset = off;
  gainNode.gain.value = isMuted ? 0 : 1;
  src.connect(gainNode);
  src.start(ctxWhen, off);
  sourceNode = src;
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

function onSongEnded() {
  playing = false; paused = false; startTime = null;
  playBtn.textContent = '▶ Грати'; pauseBtn.hidden = true;
  setStatus('Пісня закінчилась. Виберіть наступну.');
  stopAnimation(); clearHighlights();
  highlightSong(currentSong, false);
}

// Клієнт грає якщо: sync увімкнено, аудіо розблоковано, буфер є, не заглушено
function clientShouldPlay() {
  return syncAudioEnabled && audioUnlocked && audioReady && !isMuted;
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
  let wSum = 0, oSum = 0;
  for (const s of trimmed) { const w = min / s.rtt; wSum += w; oSum += s.offset * w; }
  offset = oSum / wSum;
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
// Scroll
// =============================================================================
function startScroll() {
  stopScroll();
  (function tick() {
    const diff = targetScrollY - currentScrollY;
    if (Math.abs(diff) > 0.5) {
      currentScrollY += diff * 0.04;
      if (lyricsEl) lyricsEl.style.transform = `translateY(${-currentScrollY}px)`;
    }
    scrollAnimFrame = requestAnimationFrame(tick);
  })();
}
function stopScroll() {
  if (scrollAnimFrame) { cancelAnimationFrame(scrollAnimFrame); scrollAnimFrame = null; }
}
function resetScroll() {
  currentScrollY = 0; targetScrollY = 0;
  if (lyricsEl) lyricsEl.style.transform = 'translateY(0)';
}
function updateScroll() {
  if (!lyricsContainer || !lyricsEl) return;
  const activeSpan = lyricsEl.querySelector('.word.active');
  if (!activeSpan) return;
  const containerH    = lyricsContainer.clientHeight;
  const wordTop       = activeSpan.offsetTop;
  targetScrollY       = Math.max(0, wordTop - containerH * 0.4);
}

// =============================================================================
// Song list
// =============================================================================
async function loadSongList() {
  try {
    const res = await fetch(WORKER_URL + '/api/songs');
    songs = res.ok ? await res.json() : ['test'];
  } catch { songs = ['test']; }
}

function buildSongList() {
  if (!songList) return;
  songList.innerHTML = '';
  songs.forEach((s, i) => {
    const li   = document.createElement('li');
    const name = s.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    li.dataset.song = s;
    li.innerHTML    = `<span class="num">${i + 1}</span><span class="name">${name}</span>`;
    li.addEventListener('click', () => selectSong(s));
    songList.appendChild(li);
  });
}

function selectSong(song) {
  if (song === currentSong) return;
  currentSong = song;
  highlightSong(song, false);
  loadLyrics(song);
  if (role === 'host') {
    if (!playing) playBtn.hidden = false;
    for (const k of Object.keys(buffers)) { if (k !== song) delete buffers[k]; }
    getCtx();
    loadBuffer(song).then(() => { audioReady = true; }).catch(console.error);
  }
}

function highlightSong(song, isPlaying) {
  if (!songList) return;
  songList.querySelectorAll('li').forEach(li => {
    const active = li.dataset.song === song;
    li.classList.toggle('active', active);
    const ex = li.querySelector('.playing-icon');
    if (ex) ex.remove();
    if (active && isPlaying) {
      const icon = document.createElement('span');
      icon.className = 'playing-icon'; icon.textContent = '🎵';
      li.appendChild(icon);
    }
  });
}

// =============================================================================
// Speaker toggle (клієнт)
// =============================================================================
function updateSpeakerUI() {
  if (!headerToggle) return;
  const icon = headerToggle.querySelector('.speaker-icon');
  if (icon) icon.textContent = isMuted ? '🔇' : '🔊';
  headerToggle.classList.toggle('muted', isMuted);
}

if (headerToggle) {
  headerToggle.addEventListener('click', () => {
    isMuted = !isMuted;
    if (gainNode) gainNode.gain.value = isMuted ? 0 : 1;
    updateSpeakerUI();
  });
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
  if (id) {
    roomId = id;
    const myHostRoom = localStorage.getItem('karaoke_host_room');
    if (myHostRoom === id) {
      // Хост — входить одразу без join screen
      getCtx();
      audioUnlocked = true;
      await enterRoom(id);
    } else {
      // Клієнт — показуємо join screen
      joinScreen.hidden = false;
    }
  } else {
    homeView.hidden = false;
  }
}

function parseRoomFromPath() {
  const m = location.pathname.match(/\/room\/([a-z0-9]+)/i);
  return m ? m[1] : null;
}

// =============================================================================
// Join button — єдиний user gesture для клієнта
// =============================================================================
if (joinBtn) {
  joinBtn.addEventListener('click', async () => {
    // USER GESTURE — тут розблоковуємо AudioContext (iOS Safari вимагає)
    unlockAudio();
    requestWakeLock();
    joinScreen.hidden = true;
    await enterRoom(roomId);
  });
}

// =============================================================================
// Create room
// =============================================================================
createBtn.addEventListener('click', async () => {
  createBtn.disabled = true; createBtn.textContent = 'Створення…';
  try {
    const clientId = crypto.randomUUID();
    localStorage.setItem('karaoke_client_id', clientId);
    const res = await fetch(`${WORKER_URL}/create?clientId=${encodeURIComponent(clientId)}`);
    if (!res.ok) throw new Error(res.status);
    const { roomId: id } = await res.json();
    localStorage.setItem('karaoke_host_room', id);
    history.pushState(null, '', '/room/' + id);
    getCtx(); audioUnlocked = true;
    await enterRoom(id);
  } catch (err) {
    createBtn.disabled = false; createBtn.textContent = '🎵 Створити кімнату';
    setStatus('Помилка: ' + err.message);
  }
});

// =============================================================================
// Enter room
// =============================================================================
async function enterRoom(id) {
  roomId = id;
  homeView.hidden = true; joinScreen.hidden = true; roomView.hidden = false;
  roomUrlEl.textContent = location.href;
  setStatus('Синхронізація…'); await syncTime(id);
  setStatus('Підключення…'); connectWS(id);
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
  ws.addEventListener('message', e => {
    try { onMessage(JSON.parse(e.data)); } catch(err) { console.error('onMessage:', err); }
  });
  ws.addEventListener('close', () => { setStatus('Перепідключення…'); setTimeout(() => connectWS(id), 2000); });
  ws.addEventListener('error', () => setStatus('Помилка WebSocket.'));
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
        joinScreen.hidden = true;
        buildSongList();
        songPicker.hidden = false; playBtn.hidden = true;
        pauseBtn.hidden = true; syncLabel.hidden = false;
        headerToggle.hidden = true; lyricsContainer.hidden = true;
        // Відновлюємо стан галочки
        const savedSync = localStorage.getItem('karaoke_sync_audio') === '1';
        syncCheck.checked = savedSync;
        syncLabel.classList.toggle('on', savedSync);
        if (savedSync && ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'sync_audio', enabled: true }));
        }
        setStatus('Виберіть пісню зі списку нижче.');
      } else {
        // Клієнт
        songPicker.hidden = true; playBtn.hidden = true;
        pauseBtn.hidden = true; syncLabel.hidden = true;
        // Завжди ховаємо headerToggle — покажемо тільки через sync_audio
        headerToggle.hidden = true;
        lyricsContainer.hidden = true;
        syncAudioEnabled = false; // скидаємо — отримаємо від сервера
        setStatus('Очікування хоста…');
      }
      break;

    case 'pong':
      addSample(msg.serverTime, msg.clientTime);
      break;

    case 'play':
      startTime        = msg.startTime;
      pauseTime        = null; paused = false;
      syncAudioEnabled = msg.syncAudio || false;
      if (msg.song !== currentSong) { currentSong = msg.song; loadLyrics(msg.song); }
      onPlay(msg.song);
      break;

    case 'pause':
      onPause(); break;

    case 'resume':
      startTime        = msg.startTime;
      pauseTime        = null; paused = false;
      syncAudioEnabled = msg.syncAudio || false;
      onResume(msg.song); break;

    case 'stop':
      onStop(); break;

    case 'sync_audio':
      syncAudioEnabled = msg.enabled;
      if (role === 'host') break;

      if (msg.enabled) {
        // Показуємо динамік
        headerToggle.hidden = false;
        updateSpeakerUI();
        if (isMuted) break; // заглушено — не завантажуємо
        // Завантажуємо буфер і грає якщо вже відтворення
        if (currentSong) {
          if (!buffers[currentSong]) {
            setStatus('⏳ Завантаження…');
            loadBuffer(currentSong).then(() => {
              audioReady = true; setStatus('');
              if (playing && !paused && startTime !== null) scheduleAudio();
            }).catch(e => setStatus('⚠ ' + e.message));
          } else {
            audioReady = true;
            if (playing && !paused && startTime !== null) scheduleAudio();
          }
        }
      } else {
        headerToggle.hidden = true;
        stopAudioNode();
        audioReady = false;
        setStatus('Очікування хоста…');
      }
      break;

    case 'promoted':
      role = 'host';
      buildSongList(); songPicker.hidden = false;
      playBtn.hidden = !currentSong; syncLabel.hidden = false;
      headerToggle.hidden = true;
      setStatus('Ви тепер хост.');
      if (currentSong) loadBuffer(currentSong).then(() => { audioReady = true; }).catch(() => {});
      break;
  }
}

// =============================================================================
// Host controls
// =============================================================================
playBtn.addEventListener('click', () => {
  if (!ws || ws.readyState !== WebSocket.OPEN || role !== 'host') return;
  getCtx();
  if (!playing) ws.send(JSON.stringify({ type: 'play', song: currentSong || songs[0] || 'test' }));
  else ws.send(JSON.stringify({ type: 'stop' }));
});

pauseBtn.addEventListener('click', () => {
  if (!ws || ws.readyState !== WebSocket.OPEN || role !== 'host' || !playing) return;
  ws.send(JSON.stringify({ type: paused ? 'resume' : 'pause', song: currentSong }));
});

syncCheck.addEventListener('change', () => {
  syncLabel.classList.toggle('on', syncCheck.checked);
  if (role === 'host' && ws && ws.readyState === WebSocket.OPEN) {
    localStorage.setItem('karaoke_sync_audio', syncCheck.checked ? '1' : '0');
    ws.send(JSON.stringify({ type: 'sync_audio', enabled: syncCheck.checked }));
  }
});

// =============================================================================
// Playback handlers
// =============================================================================
async function onPlay(song) {
  playing = true; paused = false;
  requestWakeLock();
  if (role === 'host') {
    playBtn.hidden = false;
    playBtn.textContent = '⏹ Стоп';
    pauseBtn.hidden = false; pauseBtn.textContent = '⏸ Пауза';
    highlightSong(song, true);
  }
  lyricsContainer.hidden = false;
  resetScroll(); setStatus(''); startAnimation(); startScroll();

  if (role === 'host') {
    if (!buffers[song]) {
      try { await loadBuffer(song); audioReady = true; }
      catch (e) { setStatus('⚠ ' + e.message); return; }
    }
    scheduleAudio();
  } else if (syncAudioEnabled && audioUnlocked && !isMuted) {
    // Завантажуємо буфер якщо нема
    if (!buffers[song]) {
      try {
        setStatus('⏳ Завантаження…');
        await loadBuffer(song);
        audioReady = true;
        setStatus('');
      } catch (e) { return; }
    } else {
      audioReady = true;
    }
    scheduleAudio();
  }
}

function onPause() {
  paused = true; stopAudioNode(); stopAnimation(); stopScroll();
  if (role === 'host') { pauseBtn.textContent = '▶ Продовжити'; setStatus('Пауза.'); }
  else setStatus('Хост поставив на паузу…');
}

function onResume(song) {
  paused = false; setStatus(''); startAnimation(); startScroll(); requestWakeLock();
  if (role === 'host') { pauseBtn.textContent = '⏸ Пауза'; scheduleAudio(); }
  else if (syncAudioEnabled && audioUnlocked && audioReady && !isMuted) scheduleAudio();
}

function onStop() {
  playing = false; paused = false; startTime = null; pauseTime = null;
  stopAudioNode(); releaseWakeLock();
  stopAnimation(); stopScroll(); clearHighlights(); resetScroll();
  audioReady = false;
  if (role === 'host') {
    playBtn.textContent = '▶ Грати'; pauseBtn.hidden = true;
    highlightSong(currentSong, false);
    if (currentSong) loadBuffer(currentSong).then(() => { audioReady = true; }).catch(() => {});
    setStatus('Зупинено. Виберіть пісню та натисніть «Грати».');
  } else {
    setStatus('Очікування хоста…');
  }
}

// =============================================================================
// Lyrics
// =============================================================================
async function loadLyrics(song) {
  try {
    const res = await fetch('/songs/' + song + '.json');
    if (!res.ok) { lyricsEl.innerHTML = ''; lyrics = []; return; }
    lyrics = await res.json(); renderWords(); resetScroll();
  } catch { lyricsEl.innerHTML = ''; lyrics = []; }
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
    const t = (serverNow() - startTime) / 1000;
    highlight(t);
    updateScroll();
    animFrame = requestAnimationFrame(tick);
  })();
}
function stopAnimation() { if (animFrame) { cancelAnimationFrame(animFrame); animFrame = null; } }

function highlight(t) {
  document.querySelectorAll('.word').forEach((s, i) => {
    const w = lyrics[i];
    s.classList.toggle('active', t >= w.start && t < w.end);
    s.classList.toggle('done',   t >= w.end && !(t >= w.start && t < w.end));
  });
}
function clearHighlights() {
  document.querySelectorAll('.word').forEach(s => s.classList.remove('active','done'));
}
function setStatus(m) { if (statusEl) statusEl.textContent = m; }

document.addEventListener('click', e => {
  if (e.target.id !== 'room-url') return;
  navigator.clipboard.writeText(e.target.textContent).then(() => {
    const o = e.target.textContent; e.target.textContent = 'Скопійовано!';
    setTimeout(() => { e.target.textContent = o; }, 1500);
  });
});

init();
