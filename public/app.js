// =============================================================================
// Karaoke – frontend v5
// =============================================================================
const WORKER_URL = 'https://pisni.slovo-wiry.workers.dev';
'use strict';

// ── Стан ─────────────────────────────────────────────────────────────────────
let ws             = null;
let role           = null;
let roomId         = null;

let playing        = false;
let paused         = false;
let startTime      = null;
let currentSong    = null;

let audioCtx       = null;
let gainNode       = null;
let sourceNode     = null;
let audioBuffer    = null;
let loadingSong    = null;
let audioUnlocked  = false;
let isMuted        = false;

let syncAudioEnabled = false;
let clockSamples   = [];
let offset         = 0;

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
  const buf = audioCtx.createBuffer(1, 1, 22050);
  const src = audioCtx.createBufferSource();
  src.buffer = buf; src.connect(audioCtx.destination); src.start(0);
  if (audioCtx.state === 'suspended') audioCtx.resume();
  audioUnlocked = true;
}

async function ensureBuffer(song) {
  if (audioBuffer && currentSong === song) return audioBuffer;
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
  } catch (e) { loadingSong = null; audioBuffer = null; throw e; }
}

function clearBuffer() { audioBuffer = null; loadingSong = null; }

// =============================================================================
// Планування відтворення
// =============================================================================
async function scheduleAudio() {
  if (!audioBuffer || startTime === null || !audioCtx) return;
  stopNode();
  if (audioCtx.state !== 'running') { try { await audioCtx.resume(); } catch {} }
  const msUntil = startTime - serverNow();
  const elapsed = Math.max(0, -msUntil / 1000);
  const off     = Math.min(elapsed, audioBuffer.duration - 0.01);
  if (off >= audioBuffer.duration) return;
  const when = Math.max(audioCtx.currentTime + 0.005, audioCtx.currentTime + msUntil / 1000);
  const src = audioCtx.createBufferSource();
  src.buffer = audioBuffer;
  src._when  = when;
  src._off   = off;
  gainNode.gain.value = isMuted ? 0 : 1;
  src.connect(gainNode);
  src.start(when, off);
  sourceNode = src;
  _syncRate = 1.0; // скидаємо після кожного (пере)запуску
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
  _resetRate();
}

function songEnded() {
  playing = false; paused = false; startTime = null;
  playBtn.hidden = false; playBtn.textContent = '▶ Грати';
  pauseBtn.hidden = true;
  setStatus('Пісня закінчилась. Виберіть наступну.');
  stopAnim(); clearHL(); highlightSong(currentSong, false);
}

// =============================================================================
// Синхронізація годинника (NTP-like)
// =============================================================================
// КРИТИЧНО: змінні для суми НЕ називаються "ws" — це тінило б глобальний WebSocket!
function serverNow() { return Date.now() + offset; }

function addSample(srvTime, t0) {
  const rtt = Date.now() - t0;
  clockSamples.push({ off: srvTime - (t0 + rtt / 2), rtt });
  if (clockSamples.length > 16) clockSamples.shift();
  const sorted = [...clockSamples].sort((a, b) => a.rtt - b.rtt);
  const use    = sorted.slice(0, Math.max(2, Math.floor(sorted.length * 0.7)));
  const minRtt = use[0].rtt;
  let wsum = 0, osum = 0;
  for (const s of use) { const w = minRtt / s.rtt; wsum += w; osum += s.off * w; }
  offset = osum / wsum;
}

async function syncOnEntry(id) {
  for (let i = 0; i < 4; i++) {
    const t0  = Date.now();
    const res = await fetch(`${WORKER_URL}/room/${id}/time`).catch(() => null);
    _dbReqs++;
    if (res?.ok) addSample((await res.json()).serverTime, t0);
    if (i < 3) await new Promise(r => setTimeout(r, 40));
  }
}

async function resync(count = 3) {
  for (let i = 0; i < count; i++) {
    const t0  = Date.now();
    const res = await fetch(`${WORKER_URL}/room/${roomId}/time`).catch(() => null);
    _dbReqs++;
    if (res?.ok) addSample((await res.json()).serverTime, t0);
    if (i < count - 1) await new Promise(r => setTimeout(r, 35));
  }
}

// audioCtx.currentTime — стабільний монотонний лічильник без jitter
function getActualPos() {
  if (!sourceNode || !audioCtx) return null;
  return sourceNode._off + (audioCtx.currentTime - sourceNode._when);
}

// =============================================================================
// Learned Rate — localStorage-кеш "ідеальної" швидкості для цього пристрою
// =============================================================================
// Кожен пристрій має мікроскопічний drift oscillator-а (±30-200 ppm).
// Ми вимірюємо середній error і зберігаємо "ідеальну" швидкість у localStorage.
// Наступна сесія одразу стартує з правильною швидкістю — без зайвих корекцій.
//
// Приклад: телефон стабільно відстає на 5 мс/хв → learnedRate = 1.0000833

const _LS_RATE = 'karaoke_learned_rate';

function _lrLoad() {
  try {
    const v = parseFloat(localStorage.getItem(_LS_RATE) || '1');
    if (isFinite(v) && v >= 0.990 && v <= 1.010) return v;
  } catch {}
  return 1.0;
}

// Оновлює learned rate: повільна EMA (alpha=0.12)
// Тільки при стабільному error (мала дисперсія) — ігноруємо mережевий jitter
function _lrUpdate(error) {
  const current = _lrLoad();
  // Перетворюємо error у корекцію rate: 1 мс error → ~0.000033 корекції rate
  // (ділимо на 30 с — відповідає вікну корекції)
  const correction = error / 30.0;
  const updated    = current + correction * 0.12;
  const clamped    = Math.max(0.990, Math.min(1.010, updated));
  try { localStorage.setItem(_LS_RATE, clamped.toFixed(7)); } catch {}
  return clamped;
}

// =============================================================================
// Кільцевий буфер drift history — для аналізу тренду
// =============================================================================
// Зберігаємо останні 8 вимірів error (секунди).
// Trend = середнє → показує куди дрейфує пристрій.
// Variance = дисперсія → відрізняємо drift від мережевого jitter.

const _DRIFT_BUF = [];
const _DRIFT_MAX = 8;

function _driftPush(e) {
  _DRIFT_BUF.push(e);
  if (_DRIFT_BUF.length > _DRIFT_MAX) _DRIFT_BUF.shift();
}

function _driftTrend() {
  if (_DRIFT_BUF.length < 2) return null;
  return _DRIFT_BUF.reduce((a, b) => a + b, 0) / _DRIFT_BUF.length;
}

function _driftVariance() {
  if (_DRIFT_BUF.length < 2) return 999;
  const m = _driftTrend();
  return _DRIFT_BUF.reduce((a, b) => a + (b - m) ** 2, 0) / _DRIFT_BUF.length;
}

// =============================================================================
// Адаптивна корекція playbackRate
// =============================================================================
// targetRate = зважений компроміс між:
//   errorRate  = 1 + clamp(effectiveError / WINDOW, -MAX, +MAX)
//   learnedRate = збережена "ідеальна" швидкість пристрою
//
// effectiveError = 0.7*currentError + 0.3*trend (якщо trend стабільний)
// Зміна плавна через linearRampToValueAtTime.

const _SW = 5.0;   // вікно корекції (секунди)
const _SM = 0.02;  // ±2% максимум
const _SL = 0.20;  // LERP коефіцієнт
const _SD = 4e-4;  // мертва зона

let _syncRate    = 1.0;
let _learnedRate = 1.0;  // завантажується при старті
let _rateTimer   = null;

function _stepRate(target) {
  const c = Math.max(1 - _SM, Math.min(1 + _SM, target));
  const d = c - _syncRate;
  if (Math.abs(d) < _SD) return;
  _syncRate += d * _SL;
  if (sourceNode?.playbackRate && audioCtx)
    sourceNode.playbackRate.linearRampToValueAtTime(_syncRate, audioCtx.currentTime + 0.3);
  _dbRefresh();
}

function _rampTo(target) {
  if (_rateTimer) { clearInterval(_rateTimer); _rateTimer = null; }
  let steps = 0;
  _rateTimer = setInterval(() => {
    if (!sourceNode || !playing || paused) { clearInterval(_rateTimer); _rateTimer = null; return; }
    _stepRate(target);
    if (++steps > 40 || Math.abs(_syncRate - target) < _SD) { clearInterval(_rateTimer); _rateTimer = null; }
  }, 75);
}

function _resetRate() {
  _syncRate = 1.0;
  if (_rateTimer) { clearInterval(_rateTimer); _rateTimer = null; }
  if (sourceNode?.playbackRate && audioCtx) {
    sourceNode.playbackRate.cancelScheduledValues(audioCtx.currentTime);
    sourceNode.playbackRate.setValueAtTime(1.0, audioCtx.currentTime);
  }
  _dbRefresh();
}

function _calcRate(error) {
  const trend = _driftTrend();
  // Якщо trend стабільний (мала дисперсія) — додаємо його до корекції
  const effErr = (trend !== null && _driftVariance() < 0.0003)
    ? error * 0.7 + trend * 0.3
    : error;
  const errRate = 1 + Math.max(-_SM, Math.min(_SM, effErr / _SW));
  // Зважений баланс: errorRate + learnedRate
  return Math.max(1 - _SM, Math.min(1 + _SM, (errRate + _learnedRate) / 2));
}

// =============================================================================
// Debug-панель
// =============================================================================
let _dbEl = null, _dbReqs = 0, _dbLastErr = null, _dbInterval = '—';

function _dbInit() {
  _dbEl = document.createElement('div');
  _dbEl.style.cssText = [
    'position:fixed','bottom:4px','left:0','right:0','text-align:center',
    'font-size:10px','color:#888','pointer-events:none','z-index:9999',
    'font-family:monospace','letter-spacing:0.02em',
  ].join(';');
  document.body.appendChild(_dbEl);
  _dbRefresh();
}

function _dbRefresh() {
  if (!_dbEl) return;
  const e   = _dbLastErr;
  const err = e !== null ? (e >= 0 ? '+' : '') + (e * 1000).toFixed(1) + ' ms' : '—';
  const clk = (offset >= 0 ? '+' : '') + offset.toFixed(0) + ' ms';
  const tr  = _driftTrend();
  const trd = tr !== null ? (tr >= 0 ? '+' : '') + (tr * 1000).toFixed(1) : '—';
  _dbEl.textContent =
    'err: ' + err + '  trend: ' + trd + ' ms' +
    '  rate: ' + _syncRate.toFixed(5) +
    '  learned: ' + _learnedRate.toFixed(5) +
    '  clk: ' + clk + '  Δt: ' + _dbInterval + '  HTTP: ' + _dbReqs;
}

// =============================================================================
// Головна функція корекції синхрону
// =============================================================================
//
// ПОВЕДІНКА:
//   1. error > 30 мс → seek одразу (ривок на місце як просив користувач)
//      + перезапуск таймерів (КРИТИЧНО — без цього таймери вмирали!)
//   2. error ≤ 30 мс → плавна корекція playbackRate
//   3. Після кожного виміру → оновлення learned rate і drift history
//
// КЛЮЧОВИЙ БАГ v4 що тут виправлений:
//   checkAndCorrect → scheduleAudio → повертає, але schedulePostStartCorrections
//   НЕ викликається → таймери вмирають → синхронізація зупиняється назавжди

async function checkAndCorrect() {
  if (!playing || paused || startTime === null) return;

  const t0  = Date.now();
  const res = await fetch(`${WORKER_URL}/room/${roomId}/time`).catch(() => null);
  _dbReqs++;
  if (!res?.ok) return;
  addSample((await res.json()).serverTime, t0);

  const targetPos = (serverNow() - startTime) / 1000;
  const actualPos = getActualPos();

  if (actualPos === null) {
    // sourceNode зник — перезапускаємо
    await scheduleAudio();
    schedulePostStartCorrections();
    return;
  }

  const error    = targetPos - actualPos;
  const absError = Math.abs(error);

  _driftPush(error);
  _dbLastErr = error;

  // Оновлюємо learned rate тільки при стабільному error (не jitter)
  if (_DRIFT_BUF.length >= 4 && _driftVariance() < 0.0004) {
    _learnedRate = _lrUpdate(error);
  }

  _dbRefresh();

  // ── error > 30 мс: seek на місце + перезапуск таймерів ───────────────────
  // 30 мс — непомітний на слух ривок, зате одразу стає на місце
  if (absError > 0.030) {
    _resetRate();
    await scheduleAudio();
    schedulePostStartCorrections(); // ← КРИТИЧНО: без цього синк вмирав назавжди
    return;
  }

  // ── error ≤ 30 мс: плавна корекція швидкістю ─────────────────────────────
  const target = _calcRate(error);
  if (absError > 0.008) { _rampTo(target); }
  else if (absError > 0.002) { _stepRate(target); }
  else { _stepRate(_learnedRate); } // ідеально — тримаємо learned rate
}

// =============================================================================
// Адаптивний планувальник (1 HTTP на тік, не 4 як раніше)
// =============================================================================
let correctionTimers = [];
let _syncTimeout     = null;
let _syncConsecOk    = 0;
let _syncMs          = 1000;
let _syncFastTicks   = 0;  // тіки після seek для підтвердження

function schedulePostStartCorrections() {
  correctionTimers.forEach(t => clearTimeout(t));
  correctionTimers = [];
  _syncConsecOk  = 0;
  _syncFastTicks = 0;
  _syncMs        = 800;
  correctionTimers.push(setTimeout(() => checkAndCorrect(), 2000));
  startPeriodicSync();
}

function startPeriodicSync() {
  stopPeriodicSync();

  async function tick() {
    if (!playing || paused) { _next(5000); return; }
    await checkAndCorrect();

    const absErr = _dbLastErr !== null ? Math.abs(_dbLastErr) : 0.1;

    if (_syncFastTicks < 6) {
      // Перші 6 тіків після seek: підтверджуємо що стало на місце
      _syncFastTicks++;
      _syncMs = absErr > 0.015 ? 800 : 1200;
    } else {
      // Адаптивний режим
      if (absErr < 0.004) {
        _syncConsecOk++;
        if      (_syncConsecOk >= 20) _syncMs = Math.min(_syncMs * 1.6, 45000);
        else if (_syncConsecOk >= 10) _syncMs = Math.min(_syncMs * 1.3, 20000);
        else                          _syncMs = Math.min(_syncMs * 1.1, 8000);
      } else {
        _syncConsecOk = 0;
        _syncMs = absErr > 0.050 ? 800 : absErr > 0.020 ? 1500 : 3500;
      }
    }

    _dbInterval = _syncMs >= 1000 ? (_syncMs / 1000).toFixed(1) + 's' : _syncMs + 'ms';
    _dbRefresh();
    _next(_syncMs);
  }

  function _next(ms) { _syncTimeout = setTimeout(() => tick().catch(console.error), ms); }
  _next(_syncMs);
}

function stopPeriodicSync() {
  if (_syncTimeout) { clearTimeout(_syncTimeout); _syncTimeout = null; }
}

function cancelCorrections() {
  correctionTimers.forEach(t => clearTimeout(t));
  correctionTimers = [];
  stopPeriodicSync();
  _resetRate();
}

// =============================================================================
// Wake Lock
// =============================================================================
async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  if (wakeLock && !wakeLock.released) return;
  try { wakeLock = await navigator.wakeLock.request('screen'); } catch {}
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
function stopScroll()  { if (scrollFrame) { cancelAnimationFrame(scrollFrame); scrollFrame = null; } }
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
    _dbReqs++;
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
  _dbInit();
  _learnedRate = _lrLoad();  // завантажуємо збережену швидкість одразу
  const p = new URLSearchParams(location.search).get('p');
  if (p) history.replaceState(null, '', p);
  await loadSongList();
  const id = parseRoom();
  if (id) {
    roomId = id;
    if (localStorage.getItem('karaoke_host_room') === id) {
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

window.addEventListener('beforeunload', () => {
  if (role !== 'host' || !roomId) return;
  const cid = localStorage.getItem('karaoke_client_id') || '';
  navigator.sendBeacon(`${WORKER_URL}/room/${roomId}/host-stop?clientId=${encodeURIComponent(cid)}`);
});

// =============================================================================
// Join / Create
// =============================================================================
if (joinBtn) {
  joinBtn.addEventListener('click', async () => {
    unlockAudio(); requestWakeLock();
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
    _dbReqs++;
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

    case 'joined': {
      role = msg.role;
      addSample(msg.serverTime, Date.now() - 30);
      if (role === 'host') {
        joinScreen.hidden = true; buildSongList();
        songPicker.hidden = false; playBtn.hidden = true; pauseBtn.hidden = true;
        syncLabel.hidden = false; setHeaderToggle(false); lyricsCont.hidden = true;
        const saved = localStorage.getItem('karaoke_sync_audio') === '1';
        syncCheck.checked = saved; syncLabel.classList.toggle('on', saved);
        syncAudioEnabled = saved;
        if (saved) ws.send(JSON.stringify({ type: 'sync_audio', enabled: true }));
        setStatus('Виберіть пісню зі списку нижче.');
        requestWakeLock();
      } else {
        songPicker.hidden = true; playBtn.hidden = true;
        pauseBtn.hidden = true; syncLabel.hidden = true; lyricsCont.hidden = true;
        syncAudioEnabled = msg.syncAudio || false;
        setHeaderToggle(syncAudioEnabled);
        setStatus('Очікування хоста…');
      }
      break;
    }

    case 'pong': break;

    case 'play': {
      const incomingSong = msg.song;
      startTime        = msg.startTime;
      paused           = false;
      syncAudioEnabled = msg.syncAudio || false;
      if (incomingSong !== currentSong) {
        stopNode(); clearBuffer();
        currentSong = incomingSong;
        await loadLyrics(incomingSong);
      }
      // Скидаємо drift history і перезавантажуємо learned rate при новій пісні
      _DRIFT_BUF.length = 0;
      _learnedRate = _lrLoad();
      _dbReqs = 0;
      await doPlay(incomingSong);
      break;
    }

    case 'pause': {
      paused = true;
      cancelCorrections(); stopNode(); stopAnim(); stopScroll();
      if (role === 'host') { pauseBtn.textContent = '▶ Продовжити'; setStatus('Пауза.'); }
      else setStatus('Хост поставив на паузу…');
      break;
    }

    case 'resume': {
      startTime        = msg.startTime;
      paused           = false;
      syncAudioEnabled = msg.syncAudio || false;
      startAnim(); startScroll(); requestWakeLock(); setStatus('');
      if (role === 'host') { pauseBtn.textContent = '⏸ Пауза'; }
      if (role === 'host' || (syncAudioEnabled && audioUnlocked && audioBuffer && !isMuted)) {
        await resync(3);
        scheduleAudio();
        schedulePostStartCorrections();
      }
      break;
    }

    case 'stop': {
      playing = false; paused = false; startTime = null;
      cancelCorrections(); stopNode();
      if (gainNode) gainNode.gain.setValueAtTime(0, audioCtx?.currentTime || 0);
      releaseWakeLock(); stopAnim(); stopScroll(); clearHL(); resetScroll();
      setTimeout(() => {
        if (gainNode) gainNode.gain.setValueAtTime(isMuted ? 0 : 1, audioCtx?.currentTime || 0);
      }, 100);
      if (role === 'host') {
        playBtn.hidden = false; playBtn.textContent = '▶ Грати'; pauseBtn.hidden = true;
        highlightSong(currentSong, false);
        setStatus('Зупинено. Виберіть пісню та натисніть «Грати».');
      } else { setStatus('Очікування хоста…'); }
      break;
    }

    case 'sync_audio': {
      syncAudioEnabled = msg.enabled;
      if (role === 'host') break;
      if (msg.enabled) {
        setHeaderToggle(true);
        if (msg.song && msg.song !== currentSong) {
          currentSong = msg.song; clearBuffer(); await loadLyrics(msg.song);
        }
        if (!isMuted && audioUnlocked && currentSong) {
          if (!audioBuffer) {
            setStatus('⏳ Завантаження…');
            try {
              await Promise.all([ensureBuffer(currentSong), resync(3)]);
              setStatus('');
            } catch (e) { setStatus('⚠ ' + e.message); break; }
          }
          if (playing && !paused && startTime !== null) {
            await resync(2);
            scheduleAudio();
            schedulePostStartCorrections();
          }
        }
      } else {
        setHeaderToggle(false); stopNode(); clearBuffer();
        setStatus('Очікування хоста…');
      }
      break;
    }

    case 'promoted': {
      role = 'host';
      buildSongList(); songPicker.hidden = false;
      playBtn.hidden = !currentSong; syncLabel.hidden = false;
      setHeaderToggle(false); setStatus('Ви тепер хост.');
      break;
    }
  }
}

// =============================================================================
// doPlay
// =============================================================================
async function doPlay(song) {
  playing = true; paused = false;
  requestWakeLock();
  if (role === 'host') {
    if (!audioBuffer) {
      playing = false; playBtn.hidden = false; playBtn.textContent = '▶ Грати';
      playBtn.disabled = false; pauseBtn.hidden = true;
      setStatus('⚠ Буфер не завантажено — натисніть «Грати» ще раз');
      return;
    }
    playBtn.hidden = false; playBtn.textContent = '⏹ Стоп';
    pauseBtn.hidden = false; pauseBtn.textContent = '⏸ Пауза';
    highlightSong(song, true);
  }
  lyricsCont.hidden = false;
  resetScroll(); setStatus(''); startAnim(); startScroll();
  if (role === 'host') {
    await resync(3);
    scheduleAudio();
    schedulePostStartCorrections();
  } else if (syncAudioEnabled && audioUnlocked && !isMuted) {
    if (!audioBuffer || currentSong !== song) {
      stopNode(); clearBuffer(); setStatus('⏳ Завантаження…');
      try {
        await Promise.all([ensureBuffer(song), resync(3)]);
        setStatus('');
      } catch (e) { stopNode(); clearBuffer(); setStatus('⚠ ' + e.message); return; }
    }
    await resync(2);
    scheduleAudio();
    schedulePostStartCorrections();
  }
}

// =============================================================================
// Контроли хоста
// =============================================================================
playBtn?.addEventListener('click', async () => {
  if (!ws || ws.readyState !== WebSocket.OPEN || role !== 'host') return;
  if (playing) { ws.send(JSON.stringify({ type: 'stop' })); return; }
  const song = currentSong || songs[0] || 'test';
  if (!audioBuffer || currentSong !== song) {
    setStatus('⏳ Завантаження…'); playBtn.disabled = true;
    try { await ensureBuffer(song); setStatus(''); }
    catch (e) { playBtn.disabled = false; setStatus('⚠ ' + e.message + ' — натисніть «Грати» ще раз'); return; }
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
      const br = document.createElement('div'); br.style.height = '1.4em';
      lyricsEl.appendChild(br);
    }
    const s = document.createElement('span');
    s.textContent = e.word; s.className = 'word';
    s.dataset.i = i; s.dataset.word = e.word;
    lyricsEl.appendChild(s);
    lyricsEl.appendChild(document.createTextNode(' '));
  });
}

// =============================================================================
// Animation
// =============================================================================
let wordSpans = [];

function cacheSpans() { wordSpans = Array.from(lyricsEl?.querySelectorAll('.word') || []); }

function startAnim() {
  stopAnim();
  (function tick() {
    if (!playing || paused || startTime === null) return;
    const t = (serverNow() - startTime) / 1000;
    for (let i = 0; i < wordSpans.length; i++) {
      const w = lyrics[i]; if (!w) continue;
      wordSpans[i].classList.toggle('active', t >= w.start && t < w.end);
      wordSpans[i].classList.toggle('done',   t >= w.end);
    }
    updateScroll();
    animFrame = requestAnimationFrame(tick);
  })();
}
function stopAnim() { if (animFrame) { cancelAnimationFrame(animFrame); animFrame = null; } }
function clearHL()  { wordSpans.forEach(s => s.classList.remove('active','done')); }

function setStatus(m) { if (statusEl) statusEl.textContent = m; }

document.addEventListener('click', e => {
  if (e.target.id !== 'room-url') return;
  navigator.clipboard.writeText(e.target.textContent).then(() => {
    const o = e.target.textContent; e.target.textContent = 'Скопійовано!';
    setTimeout(() => { e.target.textContent = o; }, 1500);
  });
});

init();
