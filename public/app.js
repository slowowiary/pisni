// =============================================================================
// Karaoke – frontend
// =============================================================================
const WORKER_URL = 'https://pisni.slovo-wiry.workers.dev';
'use strict';

let ws = null, role = null, playing = false, paused = false;
let lyrics = [], animFrame = null, roomId = null;
let startTime = null, pauseTime = null;
let currentSong      = null;
let buffers          = {};
let sourceNode       = null, audioCtx = null, gainNode = null;
let syncAudioEnabled = false;
let myAudioEnabled   = false;  // клієнт дав згоду (натиснув «Зайти»)
let audioReady       = false;
let wakeLock         = null;
let songs            = [];
let scrollAnimFrame  = null;
let currentScrollY   = 0;
let targetScrollY    = 0;
let clientJoined     = false;  // чи клієнт вже натиснув «Зайти»
let isMuted          = false;  // клієнт натиснув на динамік → заглушив

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
// AudioContext + GainNode
// =============================================================================
function getCtx() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (!gainNode) {
    gainNode = audioCtx.createGain();
    gainNode.gain.value = isMuted ? 0 : 1;
    gainNode.connect(audioCtx.destination);
  }
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
  const off     = Math.min(elapsed, buf.duration - 0.01);
  if (off >= buf.duration) return;
  const ctxWhen = Math.max(ctx.currentTime + 0.005, ctx.currentTime + msUntil / 1000);
  const src     = ctx.createBufferSource();
  src.buffer = buf; src._ctxWhen = ctxWhen; src._songOffset = off;
  getCtx(); // гарантуємо gainNode існує
  gainNode.gain.value = isMuted ? 0 : 1;
  src.connect(gainNode);
  src.start(ctxWhen, off);
  sourceNode = src;
  src.onended = () => {
    if (sourceNode === src) { sourceNode = null; if (role === 'host' && playing) onSongEnded(); }
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
  playing = false; paused = false; startTime = null;
  playBtn.textContent = '▶ Грати'; pauseBtn.hidden = true;
  setStatus('Пісня закінчилась. Виберіть наступну.');
  stopAnimation(); clearHighlights();
  highlightSong(currentSong, false);
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
  return syncAudioEnabled && clientJoined && audioReady;
}

// =============================================================================
// Wake Lock
// =============================================================================
async function requestWakeLock() {
  if ('wakeLock' in navigator) {
    try { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } catch {}
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
      lyricsEl.style.transform = `translateY(${-currentScrollY}px)`;
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
  const desiredScroll = wordTop - containerH * 0.4;
  targetScrollY       = Math.max(0, desiredScroll);
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
    const existing = li.querySelector('.playing-icon');
    if (existing) existing.remove();
    if (active && isPlaying) {
      const icon = document.createElement('span');
      icon.className = 'playing-icon'; icon.textContent = '🎵';
      li.appendChild(icon);
    }
  });
}

// =============================================================================
// Header speaker toggle (клієнт)
// =============================================================================
function updateSpeakerUI() {
  if (!headerToggle) return;
  const icon = headerToggle.querySelector('.speaker-icon');
  if (!icon) return;
  if (isMuted) {
    icon.textContent = '🔇';
    headerToggle.classList.add('muted');
  } else {
    icon.textContent = '🔊';
    headerToggle.classList.remove('muted');
  }
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
    // Якщо цей пристрій створював цю кімнату — входимо одразу як хост
    const myHostRoom = localStorage.getItem('karaoke_host_room');
    if (myHostRoom === id) {
      getCtx();
      clientJoined = true;
      myAudioEnabled = true;
      await enterRoom(id);
    } else {
      // Клієнт — показуємо join screen
      showJoinOrEnter(id);
    }
  } else {
    homeView.hidden = false;
  }
}

function parseRoomFromPath() {
  const m = location.pathname.match(/\/room\/([a-z0-9]+)/i);
  return m ? m[1] : null;
}

// Показуємо join screen. Після WS з'єднання якщо role=host — приховуємо його
function showJoinOrEnter(id) {
  joinScreen.hidden = false;
  joinBtn.addEventListener('click', async () => {
    joinScreen.hidden = true;
    getCtx();           // user gesture — розблоковуємо AudioContext
    myAudioEnabled  = true;
    clientJoined    = true;
    requestWakeLock();
    await enterRoom(id);
  }, { once: true });
}

// =============================================================================
// Create room (хост)
// =============================================================================
createBtn.addEventListener('click', async () => {
  createBtn.disabled = true; createBtn.textContent = 'Створення…';
  try {
    const clientId = crypto.randomUUID();
    localStorage.setItem('karaoke_client_id', clientId);
    const res = await fetch(`${WORKER_URL}/create?clientId=${encodeURIComponent(clientId)}`);
    if (!res.ok) throw new Error(res.status);
    const { roomId: id } = await res.json();
    history.pushState(null, '', '/room/' + id);
    localStorage.setItem('karaoke_host_room', id);
    getCtx();
    clientJoined = true;
    myAudioEnabled = true;
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
  setStatus('Синхронізація годинника…'); await syncTime(id);
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
        // Хост — ховаємо join screen якщо показувався
        joinScreen.hidden = true;
        buildSongList();
        songPicker.hidden      = false;
        playBtn.hidden         = true;
        pauseBtn.hidden        = true;
        syncLabel.hidden       = false;
        headerToggle.hidden    = true;  // хост не бачить динамік
        lyricsContainer.hidden = true;
        setStatus('Виберіть пісню зі списку нижче.');
      } else {
        songPicker.hidden      = true;
        playBtn.hidden         = true;
        pauseBtn.hidden        = true;
        syncLabel.hidden       = true;
        headerToggle.hidden    = true;  // сховано до увімкнення sync
        lyricsContainer.hidden = true;
        setStatus('Очікування хоста…');
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
      if (msg.song !== currentSong) { currentSong = msg.song; loadLyrics(msg.song); }
      onPlay(msg.song);
      break;

    case 'pause':
      pauseTime = msg.pauseTime; onPause(); break;

    case 'resume':
      startTime        = msg.startTime;
      pauseTime        = null; paused = false;
      syncAudioEnabled = msg.syncAudio || false;
      onResume(msg.song); break;

    case 'stop':
      onStop(); break;

    case 'sync_audio':
      syncAudioEnabled = msg.enabled;
      if (role !== 'host') {
        if (msg.enabled) {
          // Показуємо динамік клієнту
          headerToggle.hidden = false;
          updateSpeakerUI();
          // Якщо не заглушений — завантажуємо і грає
          if (!isMuted && clientJoined && myAudioEnabled && currentSong && !buffers[currentSong]) {
            getCtx();
            setStatus('⏳ Завантаження аудіо…');
            loadBuffer(currentSong)
              .then(() => {
                audioReady = true; setStatus('');
                if (playing && !paused && startTime !== null) scheduleAudio();
              })
              .catch(() => setStatus('⚠ Помилка'));
          } else if (!isMuted && audioReady && myAudioEnabled && playing && !paused && startTime !== null) {
            scheduleAudio();
          }
        } else {
          // Хост вимкнув sync
          headerToggle.hidden = true;
          audioReady = false;
          stopAudioNode();
          setStatus('Очікування хоста…');
        }
      }
      break;

    case 'promoted':
      role = 'host';
      buildSongList(); songPicker.hidden = false;
      playBtn.hidden = !currentSong; syncLabel.hidden = false;
      headerToggle.hidden = true;
      setStatus('Ви тепер хост.');
      if (currentSong) { getCtx(); loadBuffer(currentSong).then(() => { audioReady = true; }).catch(() => {}); }
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
  getCtx();
  syncLabel.classList.toggle('on', syncCheck.checked);
  if (role === 'host' && ws && ws.readyState === WebSocket.OPEN)
    ws.send(JSON.stringify({ type: 'sync_audio', enabled: syncCheck.checked }));
});

// =============================================================================
// Playback
// =============================================================================
async function onPlay(song) {
  playing = true; paused = false;
  requestWakeLock();
  if (role === 'host') {
    playBtn.textContent = '⏹ Стоп'; pauseBtn.hidden = false; pauseBtn.textContent = '⏸ Пауза';
    highlightSong(song, true);
  }
  lyricsContainer.hidden = false;
  resetScroll(); setStatus(''); startAnimation(); startScroll();

  if (role === 'host') {
    if (!buffers[song]) { try { await loadBuffer(song); audioReady = true; } catch (e) { setStatus('⚠ ' + e.message); return; } }
    scheduleAudio();
  } else if (syncAudioEnabled && clientJoined && myAudioEnabled && audioReady && !isMuted) {
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
  else if (syncAudioEnabled && clientJoined && myAudioEnabled && audioReady && !isMuted) scheduleAudio();
}

function onStop() {
  playing = false; paused = false; startTime = null; pauseTime = null;
  stopAudioNode(); releaseWakeLock(); stopAnimation(); stopScroll(); clearHighlights(); resetScroll();
  if (role === 'host') {
    playBtn.textContent = '▶ Грати'; pauseBtn.hidden = true;
    highlightSong(currentSong, false); audioReady = false;
    if (currentSong) loadBuffer(currentSong).then(() => { audioReady = true; }).catch(() => {});
    setStatus('Зупинено. Виберіть пісню та натисніть «Грати».');
  } else {
    audioReady = false; setStatus('Очікування хоста…');
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
    const active = t >= w.start && t < w.end;
    const done   = t >= w.end;
    s.classList.toggle('active', active);
    s.classList.toggle('done',   done && !active);
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
