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
let sourceNode       = null, audioCtx = null;
let gainNode         = null;   // для mute без зупинки
let syncAudioEnabled = false;
let clientJoined     = false;  // клієнт натиснув «Зайти»
let audioReady       = false;
let wakeLock         = null;
let songs            = [];
let scrollAnimFrame  = null;
let currentScrollY   = 0;
let targetScrollY    = 0;

// Mute стан — зберігається в localStorage
function getMuted()        { return localStorage.getItem('karaoke_muted') === '1'; }
function setMuted(val)     { localStorage.setItem('karaoke_muted', val ? '1' : '0'); }

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
const muteCheck       = document.getElementById('mute-check');
const songPicker      = document.getElementById('song-picker');
const songList        = document.getElementById('song-list');
const lyricsContainer = document.getElementById('lyrics-container');
const lyricsEl        = document.getElementById('lyrics');
const roomUrlEl       = document.getElementById('room-url');
const statusEl        = document.getElementById('status');

// =============================================================================
// AudioContext + GainNode (для mute без зупинки буферу)
// =============================================================================
function getCtx() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    gainNode = audioCtx.createGain();
    gainNode.connect(audioCtx.destination);
    gainNode.gain.value = getMuted() ? 0 : 1;
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function applyMute(muted) {
  if (gainNode) gainNode.gain.value = muted ? 0 : 1;
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
  // Підключаємо через gainNode для контролю гучності
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
  stopAnimation(); clearHighlights(); stopScroll(); highlightSong(currentSong, false);
}

// =============================================================================
// Resync — кілька швидких замірів після play/resume або unmute
// Відправляємо N ping підряд і одразу рестартуємо аудіо
// =============================================================================
async function resyncAndPlay(n = 5) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  // Робимо n швидких ping через HTTP (точніше ніж WS для одноразового sync)
  for (let i = 0; i < n; i++) {
    const t0  = Date.now();
    const res = await fetch(`${WORKER_URL}/room/${roomId}/time`).catch(() => null);
    if (res && res.ok) addSample((await res.json()).serverTime, t0);
    if (i < n - 1) await new Promise(r => setTimeout(r, 100));
  }
  // Тепер перезапускаємо з точної позиції
  scheduleAudio();
}

function resyncIfNeeded() {
  if (!playing || paused || startTime === null) return;
  if (!shouldPlayAudio() || !audioReady) return;
  const expected = (serverNow() - startTime) / 1000;
  const actual   = currentPos();
  if (actual === null) return;
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
    // Завжди рухаємось — навіть 1px за кадр
    if (diff > 0.05) {
      // Швидкість залежить від того наскільки далеко активне слово від низу
      let speed;
      if (diff > 150) {
        speed = 0.018;      // останній рядок — помітно швидше
      } else if (diff > 60) {
        speed = 0.006;      // 60% блока — трошки скорше
      } else {
        speed = 0.002;      // 20-30% — майже непомітно, піксель за кадр
      }
      currentScrollY += diff * speed;
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
  lyricsEl.style.transform = 'translateY(0)';
}
function updateScroll() {
  if (!lyricsContainer || !lyricsEl) return;
  const activeSpan = lyricsEl.querySelector('.word.active');
  if (!activeSpan) return;
  const containerH = lyricsContainer.clientHeight;
  // Позиція активного слова відносно поточного скролу (тобто в контейнері)
  const wordTop    = activeSpan.offsetTop;
  const wordInView = wordTop - currentScrollY; // де слово зараз видно

  // Починаємо ціль скролу на основі де слово в контейнері:
  // < 25% — починаємо дуже повільно рухати
  // 25-60% — трошки швидше  
  // > 60% — швидко підтягнути
  if (wordInView > containerH * 0.20) {
    // Ціль: тримати активне слово на рівні 20% від низу контейнера
    targetScrollY = Math.max(0, wordTop - containerH * 0.80);
  }
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
// Identity
// =============================================================================
function getMyClientId() {
  let id = localStorage.getItem('karaoke_client_id');
  if (!id) { id = crypto.randomUUID(); localStorage.setItem('karaoke_client_id', id); }
  return id;
}

// =============================================================================
// Mute UI
// =============================================================================
function updateMuteUI() {
  const muted = getMuted();
  if (muteCheck) muteCheck.checked = muted;
  applyMute(muted);
  // Оновлюємо іконку в шапці
  if (headerToggle) {
    const speaker = headerToggle.querySelector('.speaker');
    if (speaker) speaker.textContent = muted ? '🔇' : '🔊';
    headerToggle.classList.toggle('muted', muted);
  }
  // Оновлюємо на екрані входу
  const muteLabel = document.getElementById('mute-label');
  if (muteLabel) muteLabel.style.color = muted ? '#f44336' : '#555';
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
    showJoinScreen(id);
  } else {
    homeView.hidden = false;
  }
}
function parseRoomFromPath() {
  const m = location.pathname.match(/\/room\/([a-z0-9]+)/i);
  return m ? m[1] : null;
}

// =============================================================================
// Join screen
// =============================================================================
function showJoinScreen(id) {
  joinScreen.hidden = false;
  // Показуємо поточний стан mute
  updateMuteUI();
  joinBtn.addEventListener('click', async () => {
    joinScreen.hidden = true;
    // USER GESTURE — розблоковуємо AudioContext
    getCtx();
    clientJoined = true;
    requestWakeLock();
    await enterRoom(id);
  }, { once: true });
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
    history.pushState(null, '', '/room/' + id);
    getCtx();
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
// WebSocket — ping тільки для підтримки з'єднання, не для sync
// =============================================================================
function connectWS(id) {
  const url = WORKER_URL.replace('https','wss').replace('http','ws') + '/room/' + id + '/ws';
  ws = new WebSocket(url);
  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'hello', clientId: getMyClientId() }));
    // Ping рідко — тільки щоб WS не закривався
    setInterval(() => {
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: 'ping', clientTime: Date.now() }));
    }, 25000);
  });
  ws.addEventListener('message', e => {
    try { onMessage(JSON.parse(e.data)); } catch(err) { console.error('onMessage:', err); }
  });
  ws.addEventListener('close', () => { setStatus('Перепідключення…'); setTimeout(() => connectWS(id), 2000); });
  ws.addEventListener('error', () => setStatus('Помилка WebSocket.'));
}

// =============================================================================
// Mute toggle
// =============================================================================
if (muteCheck) {
  muteCheck.addEventListener('change', async () => {
    const muted = muteCheck.checked;
    setMuted(muted);
    updateMuteUI();

    if (!muted && syncAudioEnabled && clientJoined && playing && !paused && startTime !== null) {
      // Вмикає звук — завантажуємо буфер якщо нема і ресинхронізуємось
      setStatus('⏳ Синхронізація…');
      getCtx();
      if (currentSong && !buffers[currentSong]) {
        try {
          await loadBuffer(currentSong);
          audioReady = true;
        } catch (e) { setStatus('⚠ ' + e.message); return; }
      }
      // 5 швидких замірів і старт
      await resyncAndPlay(5);
      setStatus('');
    }
    // Якщо muted — gainNode вже виставлено в 0, аудіо продовжує грати тихо
    // Буфер НЕ видаляємо — просто тихо
  });
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
        buildSongList();
        songPicker.hidden      = false;
        playBtn.hidden         = true;
        pauseBtn.hidden        = true;
        syncLabel.hidden       = false;
        headerToggle.hidden    = true;
        lyricsContainer.hidden = true;
        setStatus('Виберіть пісню зі списку нижче.');
      } else {
        songPicker.hidden      = true;
        playBtn.hidden         = true;
        pauseBtn.hidden        = true;
        syncLabel.hidden       = true;
        lyricsContainer.hidden = true;
        // Показуємо кнопку mute в шапці
        headerToggle.hidden    = false;
        updateMuteUI();
        setStatus('Очікування хоста…');
      }
      break;

    case 'pong':
      // WS ping тільки для keepalive — не використовуємо для sync
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
          // Завантажуємо буфер якщо не muted і не завантажений
          if (!getMuted() && currentSong && !buffers[currentSong]) {
            getCtx();
            setStatus('⏳ Завантаження аудіо…');
            loadBuffer(currentSong)
              .then(async () => {
                audioReady = true;
                setStatus('');
                if (playing && !paused && startTime !== null) {
                  // Буфер щойно завантажився під час відтворення —
                  // синхронізуємось і запускаємо з правильної позиції
                  await resyncAndPlay(6);
                }
              })
              .catch(() => setStatus('⚠ Не вдалось завантажити аудіо'));
          } else if (audioReady && playing && !paused && startTime !== null && !getMuted()) {
            await resyncAndPlay(6);
          }
        } else {
          // Хост вимкнув sync — зупиняємо
          audioReady = false;
          stopAudioNode();
          // Буфер НЕ чистимо — він вже завантажений
          setStatus('Очікування хоста…');
        }
      }
      break;

    case 'promoted':
      role = 'host';
      buildSongList(); songPicker.hidden = false;
      playBtn.hidden = !currentSong; syncLabel.hidden = false; headerToggle.hidden = true;
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
  if (!playing) {
    ws.send(JSON.stringify({ type: 'play', song: currentSong || songs[0] || 'test' }));
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
    if (!buffers[song]) {
      try { await loadBuffer(song); audioReady = true; } catch (e) { setStatus('⚠ ' + e.message); return; }
    }
    // Хост: 5 замірів перед стартом
    await resyncAndPlay(5);
  } else if (syncAudioEnabled && clientJoined && !getMuted()) {
    // Клієнт: завантажуємо якщо нема і ресинхронізуємось
    if (!buffers[song]) {
      setStatus('⏳ Завантаження…');
      try { await loadBuffer(song); audioReady = true; setStatus(''); } catch (e) { return; }
    }
    await resyncAndPlay(5);
  }
}

function onPause() {
  paused = true; stopAudioNode(); stopAnimation(); stopScroll();
  if (role === 'host') { pauseBtn.textContent = '▶ Продовжити'; setStatus('Пауза.'); }
  else setStatus('Хост поставив на паузу…');
}

async function onResume(song) {
  paused = false; setStatus(''); startAnimation(); startScroll(); requestWakeLock();
  if (role === 'host') {
    pauseBtn.textContent = '⏸ Пауза';
    await resyncAndPlay(5);
  } else if (syncAudioEnabled && clientJoined && audioReady && !getMuted()) {
    await resyncAndPlay(5);
  }
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
    audioReady = false;
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
    highlight(t); updateScroll();
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
