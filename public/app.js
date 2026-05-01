// =============================================================================
// Karaoke – frontend v4
// =============================================================================
const WORKER_URL = 'https://pisni.slovo-wiry.workers.dev';
'use strict';

// ── Стан ─────────────────────────────────────────────────────────────────────
let ws             = null;
let role           = null;   // 'host' | 'participant'
let roomId         = null;

// Відтворення
let playing        = false;
let paused         = false;
let startTime      = null;   // серверний ms старту (з +3с offset від worker)
let currentSong    = null;

// Аудіо
let audioCtx       = null;
let gainNode       = null;
let sourceNode     = null;
let audioBuffer    = null;   // завантажений буфер ТІЛЬКИ поточної пісні
let loadingSong    = null;   // яка пісня зараз завантажується (щоб не дублювати)
let audioUnlocked  = false;  // user gesture відбувся
let isMuted        = false;

// Sync
let syncAudioEnabled = false; // хост увімкнув "грати на всіх"
let clockSamples   = [];
let offset         = 0;

// ── Лічильник HTTP-запитів (для дебагу) ──────────────────────────────────────
const reqCount = { total: 0, session: 0 };
function countReq() { reqCount.total++; reqCount.session++; updateDebugPanel(); }

// ── Debug-панель ─────────────────────────────────────────────────────────────
let debugEl = null;
let lastSyncError = null;   // остання помилка синхрону в секундах
let lastRTT       = null;   // останній RTT в мс
let lastSyncSrc   = '—';    // 'http' або 'ws'

function initDebugPanel() {
  debugEl = document.createElement('div');
  debugEl.id = 'debug-panel';
  debugEl.style.cssText = [
    'position:fixed','bottom:6px','left:0','right:0',
    'text-align:center','font-size:11px','color:#888',
    'pointer-events:none','z-index:9999','font-family:monospace',
    'line-height:1.6','padding:0 8px',
  ].join(';');
  document.body.appendChild(debugEl);
  updateDebugPanel();
}

function updateDebugPanel() {
  if (!debugEl) return;
  const errMs = lastSyncError !== null
    ? (lastSyncError * 1000).toFixed(1).replace(/^([^-])/, '+$1') + ' ms'
    : '— ms';
  const rtt   = lastRTT !== null ? lastRTT.toFixed(0) + ' ms RTT' : '—';
  const src   = lastSyncSrc;
  const reqs  = reqCount.session;
  debugEl.textContent =
    `sync: ${errMs}  |  ${rtt}  |  via ${src}  |  HTTP req this session: ${reqs}`;
}

// UI
let lyrics         = [];
let animFrame      = null;
let scrollFrame    = null;
let currentScrollY = 0;
let targetScrollY  = 0;
let songs          = [];
let wakeLock       = null;

// ── DOM ───────────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const homeView     = $('home-view');
const joinScreen   = $('join-screen');
const joinBtn      = $('join-btn');
const roomView     = $('room-view');
const createBtn    = $('create-btn');
const playBtn      = $('play-btn');
const pauseBtn     = $('pause-btn');
const syncLabel    = $('sync-audio-label');
const syncCheck    = $('sync-audio-check');
const headerToggle = $('header-audio-toggle');
const songPicker   = $('song-picker');
const songListEl   = $('song-list');
const lyricsCont   = $('lyrics-container');
const lyricsEl     = $('lyrics');
const roomUrlEl    = $('room-url');
const statusEl     = $('status');

// =============================================================================
// AudioContext
// =============================================================================
function initAudio() {
  if (audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  gainNode  = audioCtx.createGain();
  gainNode.gain.value = isMuted ? 0 : 1;
  gainNode.connect(audioCtx.destination);
}

function unlockAudio() {
  initAudio();
  // Тихий буфер — розблоковує iOS
  const buf = audioCtx.createBuffer(1, 1, 22050);
  const src = audioCtx.createBufferSource();
  src.buffer = buf;
  src.connect(audioCtx.destination);
  src.start(0);
  if (audioCtx.state === 'suspended') audioCtx.resume();
  audioUnlocked = true;
}

// Завантажує MP3. Якщо вже завантажений — повертає кеш.
// FIX: скидає audioBuffer якщо пісня змінилась
async function ensureBuffer(song) {
  // Вже є правильний буфер
  if (audioBuffer && currentSong === song) return audioBuffer;
  // Якщо буфер від іншої пісні — скидаємо
  if (audioBuffer && currentSong !== song) audioBuffer = null;
  initAudio();
  loadingSong = song;
  try {
    const res = await fetch('/songs/' + song + '/' + song + '.mp3');
    if (!res.ok) throw new Error('MP3 not found: ' + song);
    const arr = await res.arrayBuffer();
    if (loadingSong !== song) throw new Error('Song changed during load');
    audioBuffer = await new Promise((ok, fail) => audioCtx.decodeAudioData(arr, ok, fail));
    loadingSong = null;
    return audioBuffer;
  } catch (e) {
    loadingSong = null;
    audioBuffer = null;
    throw e;
  }
}

function clearBuffer() {
  audioBuffer = null;
  loadingSong = null;
}

// =============================================================================
// Планування відтворення
// =============================================================================
async function scheduleAudio() {
  if (!audioBuffer || startTime === null || !audioCtx) return;
  stopNode();
  if (audioCtx.state !== 'running') {
    try { await audioCtx.resume(); } catch {}
  }
  const msUntil = startTime - serverNow();
  const elapsed = Math.max(0, -msUntil / 1000);
  const off     = Math.min(elapsed, audioBuffer.duration - 0.01);
  if (off >= audioBuffer.duration) return;
  const when = Math.max(audioCtx.currentTime + 0.005,
                        audioCtx.currentTime + msUntil / 1000);
  const src = audioCtx.createBufferSource();
  src.buffer = audioBuffer;
  src._when  = when;
  src._off   = off;
  gainNode.gain.value = isMuted ? 0 : 1;
  src.connect(gainNode);
  src.start(when, off);
  sourceNode = src;
  src.onended = () => {
    if (sourceNode === src) { sourceNode = null; if (role === 'host' && playing) songEnded(); }
  };
}

function stopNode() {
  if (sourceNode) {
    try { sourceNode.stop(0); } catch {}
    try { sourceNode.disconnect(); } catch {}
    sourceNode = null;
  }
  resetPlaybackRate();
}

function songEnded() {
  playing = false; paused = false; startTime = null;
  playBtn.hidden = false;
  playBtn.textContent = '▶ Грати';
  pauseBtn.hidden = true;
  setStatus('Пісня закінчилась. Виберіть наступну.');
  stopAnim(); clearHL(); highlightSong(currentSong, false);
}

// =============================================================================
// Синхронізація годинника
// =============================================================================
function serverNow() { return Date.now() + offset; }

function addSample(srvTime, t0, src) {
  const rtt = Date.now() - t0;
  lastRTT     = rtt;
  lastSyncSrc = src || '?';
  clockSamples.push({ off: srvTime - (t0 + rtt / 2), rtt });
  if (clockSamples.length > 12) clockSamples.shift();
  const sorted  = [...clockSamples].sort((a, b) => a.rtt - b.rtt);
  const use     = sorted.slice(0, Math.max(1, Math.floor(sorted.length * 0.7)));
  const minRtt  = use[0].rtt;
  let wsum = 0, osum = 0;
  for (const s of use) { const w = minRtt / s.rtt; wsum += w; osum += s.off * w; }
  offset = osum / wsum;
  updateDebugPanel();
}

// Початкова синхронізація при вході — 4 послідовних HTTP заміри.
// Цього достатньо для точного старту; далі синхроніземось через WS pong.
async function syncOnEntry(id) {
  for (let i = 0; i < 4; i++) {
    const t0  = Date.now();
    const res = await fetch(`${WORKER_URL}/room/${id}/time`).catch(() => null);
    countReq();
    if (res?.ok) addSample((await res.json()).serverTime, t0, 'http');
    if (i < 3) await new Promise(r => setTimeout(r, 30));
  }
}

// ── Синхронізація через WebSocket ping (0 HTTP запитів!) ─────────────────────
// Надсилаємо ping по відкритому WS і чекаємо pong із serverTime.
// Якщо WS не відкритий — fallback на HTTP (рідкість: тільки при reconnect).
// count — кількість замірів для усереднення.
function wsPing() {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) { reject(new Error('ws closed')); return; }
    const t0  = Date.now();
    const tid = setTimeout(() => reject(new Error('pong timeout')), 3000);
    // Одноразовий слухач для наступного pong
    function onMsg(e) {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.type !== 'pong') return;
      ws.removeEventListener('message', onMsg);
      clearTimeout(tid);
      addSample(m.serverTime, t0, 'ws');
      resolve(Date.now() - t0); // RTT
    }
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ type: 'ping', clientTime: t0 }));
  });
}

// Виконує count WS ping-замірів. При помилці — HTTP-fallback.
async function resync(count = 3) {
  for (let i = 0; i < count; i++) {
    try {
      await wsPing();
    } catch {
      // WS недоступний — HTTP fallback (рахуємо як запит)
      const t0  = Date.now();
      const res = await fetch(`${WORKER_URL}/room/${roomId}/time`).catch(() => null);
      countReq();
      if (res?.ok) addSample((await res.json()).serverTime, t0, 'http-fb');
    }
    if (i < count - 1) await new Promise(r => setTimeout(r, 40));
  }
}

// Поточна позиція відтворення в секундах
function getActualPos() {
  if (!sourceNode || !audioCtx) return null;
  return sourceNode._off + (audioCtx.currentTime - sourceNode._when);
}

// ── Перевірка і корекція синхрону — без HTTP запитів ─────────────────────────
// Отримуємо свіжий серверний час через WS ping (безкоштовно!),
// рахуємо drift і або seekаємо, або плавно коригуємо playbackRate.
async function checkAndCorrect() {
  if (!playing || paused || startTime === null) return;

  // Один WS ping — оновлює offset і lastRTT
  try { await wsPing(); } catch {
    // Якщо WS впав — не блокуємось, просто пропускаємо цей цикл
    return;
  }

  const targetPos = (serverNow() - startTime) / 1000;
  const actualPos = getActualPos();

  if (actualPos === null) { scheduleAudio(); return; }

  const error    = targetPos - actualPos;   // + = відстаємо, - = поспішаємо
  const absError = Math.abs(error);
  lastSyncError  = error;
  updateDebugPanel();

  const CORRECTION_WINDOW = 3.0;
  const MAX_RATE_DELTA    = 0.02;
  const MIN_RATE_CHANGE   = 0.001;
  const RATE_LERP         = 0.15;

  // (A) > 120 мс — жорсткий seek + увімкнути м'яку корекцію
  if (absError > 0.120) {
    scheduleAudio();
    startRateRamp(1 + clamp(error / CORRECTION_WINDOW, -MAX_RATE_DELTA, MAX_RATE_DELTA));
    return;
  }
  // (B) 20–120 мс — тільки playbackRate
  if (absError > 0.020) {
    const targetRate = 1 + clamp(error / CORRECTION_WINDOW, -MAX_RATE_DELTA, MAX_RATE_DELTA);
    startRateRamp(targetRate);
    return;
  }
  // (C) < 20 мс — мінімальна або нульова корекція
  if (absError > 0.005) {
    const targetRate = 1 + clamp(error / CORRECTION_WINDOW, -MAX_RATE_DELTA, MAX_RATE_DELTA);
    if (sourceNode?.playbackRate) {
      const diff = targetRate - currentPlaybackRate;
      if (Math.abs(diff) >= MIN_RATE_CHANGE) {
        currentPlaybackRate += diff * RATE_LERP;
        sourceNode.playbackRate.linearRampToValueAtTime(
          currentPlaybackRate, audioCtx.currentTime + 0.3);
      }
    }
  } else {
    applyPlaybackRate(1.0);
  }
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

// ── Адаптивна синхронізація (без HTTP!) ──────────────────────────────────────
// checkAndCorrect() сам робить WS ping → не потрібен окремий resync().
// Інтервал адаптується: часто при рассинхроні, рідко при ідеальному стані.

let correctionTimers    = [];
let periodicSyncTimeout = null;
let consecutiveOk       = 0;
let syncIntervalMs      = 2000;

// Адаптивний sync-стан для playbackRate
const CORRECTION_WINDOW = 3.0;
const MAX_RATE_DELTA    = 0.02;
const RATE_LERP         = 0.12;
const MIN_RATE_CHANGE   = 0.001;
let currentPlaybackRate = 1.0;
let rateRampTimer       = null;

function applyPlaybackRate(targetRate) {
  if (!sourceNode?.playbackRate || !audioCtx) return;
  const clamped = Math.max(1 - MAX_RATE_DELTA, Math.min(1 + MAX_RATE_DELTA, targetRate));
  const diff    = clamped - currentPlaybackRate;
  if (Math.abs(diff) < MIN_RATE_CHANGE) return;
  currentPlaybackRate += diff * RATE_LERP;
  sourceNode.playbackRate.linearRampToValueAtTime(
    currentPlaybackRate, audioCtx.currentTime + 0.2);
}

function resetPlaybackRate() {
  currentPlaybackRate = 1.0;
  if (sourceNode?.playbackRate)
    sourceNode.playbackRate.setValueAtTime(1.0, audioCtx?.currentTime || 0);
  if (rateRampTimer) { clearInterval(rateRampTimer); rateRampTimer = null; }
}

function startRateRamp(targetRate) {
  if (rateRampTimer) { clearInterval(rateRampTimer); rateRampTimer = null; }
  let steps = 0;
  rateRampTimer = setInterval(() => {
    if (!sourceNode || !playing || paused) { clearInterval(rateRampTimer); rateRampTimer = null; return; }
    applyPlaybackRate(targetRate);
    if (++steps > 20 || Math.abs(currentPlaybackRate - targetRate) < MIN_RATE_CHANGE) {
      clearInterval(rateRampTimer); rateRampTimer = null;
    }
  }, 80);
}

function schedulePostStartCorrections() {
  correctionTimers.forEach(t => clearTimeout(t));
  correctionTimers = [];
  consecutiveOk  = 0;
  syncIntervalMs = 1500;

  // Перша перевірка через 2.5с (пісня вже грає, але ще свіжа)
  correctionTimers.push(setTimeout(() => checkAndCorrect(), 2500));
  startPeriodicSync();
}

function startPeriodicSync() {
  stopPeriodicSync();
  async function tick() {
    if (!playing || paused) return scheduleNext(5000);
    await checkAndCorrect();
    // Адаптуємо інтервал залежно від consecutiveOk
    // (consecutiveOk оновлюється всередині checkAndCorrect через lastSyncError)
    const absErr = lastSyncError !== null ? Math.abs(lastSyncError) : 0.1;
    if (absErr < 0.005) {
      consecutiveOk++;
      if (consecutiveOk >= 8)       syncIntervalMs = Math.min(syncIntervalMs * 1.5, 40000);
      else if (consecutiveOk >= 4)  syncIntervalMs = Math.min(syncIntervalMs * 1.2, 12000);
    } else {
      consecutiveOk  = 0;
      if (absErr > 0.050)           syncIntervalMs = 1000;
      else if (absErr > 0.020)      syncIntervalMs = 2000;
      else                          syncIntervalMs = 4000;
    }
    scheduleNext(syncIntervalMs);
  }
  function scheduleNext(ms) {
    periodicSyncTimeout = setTimeout(() => tick().catch(console.error), ms);
  }
  scheduleNext(syncIntervalMs);
}

function stopPeriodicSync() {
  if (periodicSyncTimeout) { clearTimeout(periodicSyncTimeout); periodicSyncTimeout = null; }
}

function cancelCorrections() {
  correctionTimers.forEach(t => clearTimeout(t));
  correctionTimers = [];
  stopPeriodicSync();
  if (rateRampTimer) { clearInterval(rateRampTimer); rateRampTimer = null; }
  resetPlaybackRate();
}

// =============================================================================
// Wake Lock
// =============================================================================
async function requestWakeLock() {
  if ('wakeLock' in navigator) {
    try { wakeLock = await navigator.wakeLock.request('screen'); } catch {}
  }
}
function releaseWakeLock() {
  if (role === 'host') return;
  if (wakeLock) { wakeLock.release(); wakeLock = null; }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (role === 'host' || (playing && !paused)) requestWakeLock();
});

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
    scrollFrame = requestAnimationFrame(tick);
  })();
}
function stopScroll() { if (scrollFrame) { cancelAnimationFrame(scrollFrame); scrollFrame = null; } }
function resetScroll() {
  currentScrollY = 0; targetScrollY = 0;
  if (lyricsEl) lyricsEl.style.transform = 'translateY(0)';
}
function updateScroll() {
  if (!lyricsCont || !lyricsEl) return;
  const active = lyricsEl.querySelector('.word.active');
  if (!active) return;
  targetScrollY = Math.max(0, active.offsetTop - lyricsCont.clientHeight * 0.4);
}

// =============================================================================
// Список пісень
// =============================================================================
async function loadSongList() {
  try {
    const res = await fetch(WORKER_URL + '/api/songs');
    countReq();
    songs = res.ok ? await res.json() : ['test'];
  } catch { songs = ['test']; }
}

function buildSongList() {
  if (!songListEl) return;
  songListEl.innerHTML = '';
  songs.forEach((s, i) => {
    const li   = document.createElement('li');
    const name = s.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    li.dataset.song = s;
    li.innerHTML    = `<span class="num">${i+1}</span><span class="name">${name}</span>`;
    li.addEventListener('click', () => selectSong(s));
    songListEl.appendChild(li);
  });
}

function selectSong(song) {
  if (song === currentSong) return;
  currentSong = song;
  highlightSong(song, false);
  loadLyrics(song);
  if (role === 'host') {
    if (!playing) { playBtn.hidden = false; }
    // FIX: скидаємо буфер і завантажуємо нову пісню
    clearBuffer();
    ensureBuffer(song).then(() => {}).catch(console.error);
  }
}

function highlightSong(song, isPlaying) {
  if (!songListEl) return;
  songListEl.querySelectorAll('li').forEach(li => {
    const active = li.dataset.song === song;
    li.classList.toggle('active', active);
    li.querySelector('.playing-icon')?.remove();
    if (active && isPlaying) {
      const ic = document.createElement('span');
      ic.className = 'playing-icon'; ic.textContent = '🎵';
      li.appendChild(ic);
    }
  });
}

// =============================================================================
// Динамік (клієнт)
// =============================================================================
function setHeaderToggle(show) {
  if (!headerToggle) return;
  headerToggle.hidden = !show;
  if (show) updateSpeakerUI();
}

function updateSpeakerUI() {
  if (!headerToggle) return;
  const ic = headerToggle.querySelector('.speaker-icon');
  if (ic) ic.textContent = isMuted ? '🔇' : '🔊';
  headerToggle.classList.toggle('muted', isMuted);
}

if (headerToggle) {
  headerToggle.addEventListener('click', () => {
    isMuted = !isMuted;
    if (gainNode) gainNode.gain.value = isMuted ? 0 : 1;
    updateSpeakerUI();
    // Якщо вмикаємо звук під час відтворення — синхронізуємось
    if (!isMuted && syncAudioEnabled && audioUnlocked && playing && !paused && startTime !== null) {
      resync(2).then(() => { scheduleAudio(); schedulePostStartCorrections(); });
    } else if (isMuted) {
      stopNode();
    }
  });
}

// =============================================================================
// Identity
// =============================================================================
function getClientId() {
  let id = localStorage.getItem('karaoke_client_id');
  if (!id) { id = crypto.randomUUID(); localStorage.setItem('karaoke_client_id', id); }
  return id;
}

// =============================================================================
// Boot
// =============================================================================
async function init() {
  initDebugPanel();
  const p = new URLSearchParams(location.search).get('p');
  if (p) history.replaceState(null, '', p);
  await loadSongList();
  const id = parseRoom();
  if (id) {
    roomId = id;
    if (localStorage.getItem('karaoke_host_room') === id) {
      // Хост — входить одразу
      initAudio(); audioUnlocked = true;
      await enterRoom(id);
    } else {
      joinScreen.hidden = false;
    }
  } else {
    homeView.hidden = false;
  }
}

function parseRoom() {
  const m = location.pathname.match(/\/room\/([a-z0-9]+)/i);
  return m ? m[1] : null;
}

// Коли хост закриває вкладку — надсилаємо stop через sendBeacon
window.addEventListener('beforeunload', () => {
  if (role !== 'host' || !roomId) return;
  const cid = localStorage.getItem('karaoke_client_id') || '';
  const url = `${WORKER_URL}/room/${roomId}/host-stop?clientId=${encodeURIComponent(cid)}`;
  navigator.sendBeacon(url);
});

// =============================================================================
// Join / Create
// =============================================================================
if (joinBtn) {
  joinBtn.addEventListener('click', async () => {
    unlockAudio(); // USER GESTURE — iOS вимагає тут
    requestWakeLock();
    joinScreen.hidden = true;
    await enterRoom(roomId);
  });
}

createBtn?.addEventListener('click', async () => {
  createBtn.disabled = true; createBtn.textContent = 'Створення…';
  try {
    const cid = crypto.randomUUID();
    localStorage.setItem('karaoke_client_id', cid);
    const res = await fetch(`${WORKER_URL}/create?clientId=${encodeURIComponent(cid)}`);
    countReq();
    if (!res.ok) throw new Error(res.status);
    const { roomId: id } = await res.json();
    localStorage.setItem('karaoke_host_room', id);
    history.pushState(null, '', '/room/' + id);
    initAudio(); audioUnlocked = true;
    await enterRoom(id);
  } catch (err) {
    createBtn.disabled = false; createBtn.textContent = '🎵 Створити кімнату';
    setStatus('Помилка: ' + err.message);
  }
});

async function enterRoom(id) {
  roomId = id;
  homeView.hidden = true; joinScreen.hidden = true; roomView.hidden = false;
  roomUrlEl.textContent = location.href;
  setStatus('Синхронізація…');
  await syncOnEntry(id);
  setStatus('Підключення…');
  connectWS(id);
}

// =============================================================================
// WebSocket
// =============================================================================
function connectWS(id) {
  const url = WORKER_URL.replace('https','wss').replace('http','ws') + '/room/' + id + '/ws';
  ws = new WebSocket(url);

  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'hello', clientId: getClientId() }));
    // Keepalive ping
    setInterval(() => {
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: 'ping', clientTime: Date.now() }));
    }, 20000);
  });

  ws.addEventListener('message', e => {
    try { handleMsg(JSON.parse(e.data)); } catch(err) { console.error(err); }
  });

  ws.addEventListener('close', () => {
    setStatus('Перепідключення…');
    setTimeout(() => connectWS(id), 2000);
  });
}

// =============================================================================
// Обробка повідомлень
// =============================================================================
async function handleMsg(msg) {
  switch (msg.type) {

    // ── Підключення ──────────────────────────────────────────────────────────
    case 'joined': {
      role = msg.role;
      addSample(msg.serverTime, Date.now() - 30, 'ws-join');

      if (role === 'host') {
        joinScreen.hidden = true;
        buildSongList();
        songPicker.hidden = false;
        playBtn.hidden = true; pauseBtn.hidden = true;
        syncLabel.hidden = false; setHeaderToggle(false);
        lyricsCont.hidden = true;
        // Відновлюємо стан галочки
        const saved = localStorage.getItem('karaoke_sync_audio') === '1';
        syncCheck.checked = saved;
        syncLabel.classList.toggle('on', saved);
        syncAudioEnabled = saved;
        if (saved) ws.send(JSON.stringify({ type: 'sync_audio', enabled: true }));
        setStatus('Виберіть пісню зі списку нижче.');

      } else {
        // Клієнт
        songPicker.hidden = true; playBtn.hidden = true;
        pauseBtn.hidden = true; syncLabel.hidden = true;
        lyricsCont.hidden = true;
        syncAudioEnabled = msg.syncAudio || false;
        setHeaderToggle(syncAudioEnabled);
        setStatus('Очікування хоста…');
      }
      break;
    }

    case 'pong':
      break;

    // ── Play ─────────────────────────────────────────────────────────────────
    // FIX: завжди оновлюємо currentSong з msg.song — навіть якщо пісня "та сама"
    // щоб клієнт точно знав яку пісню грати
    case 'play': {
      const incomingSong = msg.song;
      startTime          = msg.startTime;
      paused             = false;
      syncAudioEnabled   = msg.syncAudio || false;

      // FIX: якщо пісня змінилась — скидаємо буфер, завантажуємо нову
      if (incomingSong !== currentSong) {
        stopNode();
        clearBuffer();
        currentSong = incomingSong;
        await loadLyrics(incomingSong);
      }

      await doPlay(incomingSong);
      break;
    }

    // ── Pause ────────────────────────────────────────────────────────────────
    case 'pause': {
      paused = true;
      cancelCorrections();
      stopNode();
      stopAnim(); stopScroll();
      if (role === 'host') { pauseBtn.textContent = '▶ Продовжити'; setStatus('Пауза.'); }
      else setStatus('Хост поставив на паузу…');
      break;
    }

    // ── Resume ───────────────────────────────────────────────────────────────
    // FIX: більше замірів при resume для точної синхронізації після паузи
    case 'resume': {
      startTime        = msg.startTime;
      paused           = false;
      syncAudioEnabled = msg.syncAudio || false;
      startAnim(); startScroll(); requestWakeLock();
      setStatus('');
      if (role === 'host') { pauseBtn.textContent = '⏸ Пауза'; }
      if (role === 'host' || (syncAudioEnabled && audioUnlocked && audioBuffer && !isMuted)) {
        // FIX: 5 замірів (було 3) — пауза могла "розбити" offset
        await resync(5);
        scheduleAudio();
        schedulePostStartCorrections();
      }
      break;
    }

    // ── Stop ─────────────────────────────────────────────────────────────────
    case 'stop': {
      playing = false; paused = false; startTime = null;
      cancelCorrections();
      stopNode();
      if (gainNode) { gainNode.gain.setValueAtTime(0, audioCtx?.currentTime || 0); }
      releaseWakeLock();
      stopAnim(); stopScroll(); clearHL(); resetScroll();
      setTimeout(() => { if (gainNode) gainNode.gain.setValueAtTime(isMuted ? 0 : 1, audioCtx?.currentTime || 0); }, 100);
      if (role === 'host') {
        playBtn.hidden = false;
        playBtn.textContent = '▶ Грати'; pauseBtn.hidden = true;
        highlightSong(currentSong, false);
        setStatus('Зупинено. Виберіть пісню та натисніть «Грати».');
      } else {
        setStatus('Очікування хоста…');
      }
      break;
    }

    // ── Sync Audio ───────────────────────────────────────────────────────────
    // FIX: коли хост вмикає sync_audio під час відтворення —
    // завантажуємо буфер і тільки після повного завантаження синхронізуємось
    // щоб не було розсинхрону через час завантаження
    case 'sync_audio': {
      syncAudioEnabled = msg.enabled;
      if (role === 'host') break;

      if (msg.enabled) {
        setHeaderToggle(true);
        // Оновлюємо currentSong якщо worker передав нову пісню
        if (msg.song && msg.song !== currentSong) {
          currentSong = msg.song;
          clearBuffer();
          await loadLyrics(msg.song);
        }

        if (!isMuted && audioUnlocked && currentSong) {
          if (!audioBuffer) {
            setStatus('⏳ Завантаження…');
            try {
              // Паралельно: завантажуємо буфер + перші заміри
              await Promise.all([
                ensureBuffer(currentSong),
                resync(4),
              ]);
              setStatus('');
            } catch (e) {
              setStatus('⚠ ' + e.message); break;
            }
          }
          if (playing && !paused && startTime !== null) {
            // Після завантаження — ще заміри для точного старту "на льоту"
            await resync(4);
            scheduleAudio();
            schedulePostStartCorrections();
          }
        }
      } else {
        setHeaderToggle(false);
        stopNode();
        clearBuffer();
        setStatus('Очікування хоста…');
      }
      break;
    }

    case 'promoted': {
      role = 'host';
      buildSongList(); songPicker.hidden = false;
      playBtn.hidden = !currentSong; syncLabel.hidden = false;
      setHeaderToggle(false);
      setStatus('Ви тепер хост.');
      break;
    }
  }
}

// =============================================================================
// doPlay — головна логіка запуску відтворення
// =============================================================================
async function doPlay(song) {
  playing = true; paused = false;
  reqCount.session = 0; // скидаємо лічильник на кожну пісню
  updateDebugPanel();
  requestWakeLock();

  if (role === 'host') {
    // Буфер вже завантажено у playBtn handler до відправки команди play
    // Якщо з якоїсь причини буфер відсутній — скидаємо стан і виходимо
    if (!audioBuffer) {
      playing = false;
      playBtn.hidden = false; playBtn.textContent = '▶ Грати'; playBtn.disabled = false;
      pauseBtn.hidden = true;
      setStatus('⚠ Буфер не завантажено — натисніть «Грати» ще раз');
      return;
    }
    playBtn.hidden = false;
    playBtn.textContent = '⏹ Стоп';
    pauseBtn.hidden = false; pauseBtn.textContent = '⏸ Пауза';
    highlightSong(song, true);
  }

  lyricsCont.hidden = false;
  resetScroll(); setStatus(''); startAnim(); startScroll();

  if (role === 'host') {
    // Хост: resync перед стартом — є 3 секунди запасу
    await resync(3);
    scheduleAudio();
    schedulePostStartCorrections();

  } else if (syncAudioEnabled && audioUnlocked && !isMuted) {
    if (!audioBuffer || currentSong !== song) {
      stopNode();
      clearBuffer();
      setStatus('⏳ Завантаження…');
      try {
        await Promise.all([
          ensureBuffer(song),
          resync(4),
        ]);
        setStatus('');
      } catch (e) {
        stopNode(); clearBuffer();
        setStatus('⚠ ' + e.message);
        return;
      }
    }
    // Після завантаження — ще 4 заміри вже з точним offset
    await resync(4);
    scheduleAudio();
    schedulePostStartCorrections();
  }
}

// =============================================================================
// Контроли хоста
// =============================================================================
playBtn?.addEventListener('click', async () => {
  if (!ws || ws.readyState !== WebSocket.OPEN || role !== 'host') return;
  if (playing) {
    ws.send(JSON.stringify({ type: 'stop' }));
    return;
  }
  // Спочатку завантажуємо буфер — тільки після успіху надсилаємо play
  // Якщо відправити play до завантаження — всі учасники отримають команду,
  // але хост може зламатись при завантаженні і десинхронізуватись
  const song = currentSong || songs[0] || 'test';
  if (!audioBuffer || currentSong !== song) {
    setStatus('⏳ Завантаження…');
    playBtn.disabled = true;
    try {
      await ensureBuffer(song);
      setStatus('');
    } catch (e) {
      playBtn.disabled = false;
      setStatus('⚠ ' + e.message + ' — натисніть «Грати» ще раз');
      return;
    }
    playBtn.disabled = false;
  }
  ws.send(JSON.stringify({ type: 'play', song }));
});

pauseBtn?.addEventListener('click', () => {
  if (!ws || ws.readyState !== WebSocket.OPEN || role !== 'host' || !playing) return;
  ws.send(JSON.stringify({ type: paused ? 'resume' : 'pause', song: currentSong }));
});

syncCheck?.addEventListener('change', () => {
  syncLabel.classList.toggle('on', syncCheck.checked);
  syncAudioEnabled = syncCheck.checked;
  if (role === 'host' && ws?.readyState === WebSocket.OPEN) {
    localStorage.setItem('karaoke_sync_audio', syncCheck.checked ? '1' : '0');
    // FIX: передаємо також currentSong щоб клієнти знали яку пісню завантажувати
    ws.send(JSON.stringify({ type: 'sync_audio', enabled: syncCheck.checked, song: currentSong }));
  }
});

// =============================================================================
// Lyrics
// =============================================================================
async function loadLyrics(song) {
  try {
    const res = await fetch('/songs/' + song + '/' + song + '.json');
    if (!res.ok) { lyricsEl.innerHTML = ''; lyrics = []; return; }
    lyrics = await res.json(); renderWords(); cacheSpans(); resetScroll();
  } catch { lyricsEl.innerHTML = ''; lyrics = []; }
}

function renderWords() {
  lyricsEl.innerHTML = '';
  lyrics.forEach((e, i) => {
    if (i > 0 && (e.start - lyrics[i-1].end) >= 2.0) {
      const br = document.createElement('div');
      br.style.height = '1.4em';
      lyricsEl.appendChild(br);
    }
    const s = document.createElement('span');
    s.textContent = e.word;
    s.className   = 'word';
    s.dataset.i   = i;
    s.dataset.word = e.word;
    lyricsEl.appendChild(s);
    lyricsEl.appendChild(document.createTextNode(' '));
  });
}

// =============================================================================
// Animation
// =============================================================================
let wordSpans = [];

function cacheSpans() {
  wordSpans = Array.from(lyricsEl?.querySelectorAll('.word') || []);
}

function startAnim() {
  stopAnim();
  (function tick() {
    if (!playing || paused || startTime === null) return;
    const t = (serverNow() - startTime) / 1000;
    for (let i = 0; i < wordSpans.length; i++) {
      const w = lyrics[i];
      if (!w) continue;
      const active = t >= w.start && t < w.end;
      const done   = t >= w.end && !active;
      wordSpans[i].classList.toggle('active', active);
      wordSpans[i].classList.toggle('done',   done);
    }
    updateScroll();
    animFrame = requestAnimationFrame(tick);
  })();
}
function stopAnim() { if (animFrame) { cancelAnimationFrame(animFrame); animFrame = null; } }
function clearHL() {
  wordSpans.forEach(s => s.classList.remove('active','done'));
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
