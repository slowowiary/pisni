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
  _rate = 1.0; // починаємо з нормальної швидкості після кожного (пере)запуску
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

function addSample(srvTime, t0) {
  const rtt = Date.now() - t0;
  clockSamples.push({ off: srvTime - (t0 + rtt / 2), rtt });
  if (clockSamples.length > 12) clockSamples.shift();
  const sorted  = [...clockSamples].sort((a, b) => a.rtt - b.rtt);
  const use     = sorted.slice(0, Math.max(1, Math.floor(sorted.length * 0.7)));
  const minRtt  = use[0].rtt;
  let wsum = 0, osum = 0;
  for (const s of use) { const w = minRtt / s.rtt; wsum += w; osum += s.off * w; }
  offset = osum / wsum;
}

// Початкова синхронізація при вході — 4 HTTP замірів достатньо.
// Точніший offset потрібен тільки якщо пісня вже грає; але тоді
// доробляємо заміри в doPlay() паралельно з завантаженням буфера.
async function syncOnEntry(id) {
  for (let i = 0; i < 4; i++) {
    const t0  = Date.now();
    const res = await fetch(`${WORKER_URL}/room/${id}/time`).catch(() => null);
    _dbReqs++; if (res?.ok) addSample((await res.json()).serverTime, t0);
    if (i < 3) await new Promise(r => setTimeout(r, 30));
  }
}

// Послідовні заміри — повертає найкращий offset
// Використовуємо паралельні + послідовні для швидкості та точності
async function resync(count = 5) {
  for (let i = 0; i < count; i++) {
    const t0  = Date.now();
    const res = await fetch(`${WORKER_URL}/room/${roomId}/time`).catch(() => null);
    _dbReqs++;
    if (res?.ok) addSample((await res.json()).serverTime, t0);
    if (i < count - 1) await new Promise(r => setTimeout(r, 30));
  }
}

// =============================================================================
// Поточна позиція аудіо
// =============================================================================
// audioCtx.currentTime — стабільний монотонний лічильник, не залежить від
// jitter Event Loop на відміну від Date.now(). Використовуємо його для позиції.
function getActualPos() {
  if (!sourceNode || !audioCtx) return null;
  return sourceNode._off + (audioCtx.currentTime - sourceNode._when);
}

// =============================================================================
// Адаптивна корекція playbackRate
// =============================================================================
//
// ГОЛОВНА ІДЕЯ:
//   Замість жорстких seek-ів (перемотка) — плавна зміна швидкості відтворення.
//   Це непомітно для слуху і не викликає стрибків.
//
//   Формула:  targetRate = 1 + clamp(error / WINDOW, -MAX, +MAX)
//     error > 0: відстаємо  → rate > 1 (прискорюємо)
//     error < 0: поспішаємо → rate < 1 (сповільнюємо)
//
//   Зміна плавна через LERP: rate += (target - rate) * LERP
//   Застосовується через linearRampToValueAtTime (Web Audio API) — без клацань.
//
//   Seek робиться ТІЛЬКИ при великому рассинхроні (> 150 мс).

const _SYNC_WINDOW = 4.0;  // секунди — вікно корекції (більше = повільніше але плавніше)
const _SYNC_MAX    = 0.02; // ±2% максимальне відхилення швидкості
const _SYNC_LERP   = 0.18; // коефіцієнт LERP за один крок (вище = швидше але грубіше)
const _SYNC_DEAD   = 5e-4; // мертва зона: зміна менша за це — ігноруємо

let _rate      = 1.0;   // поточна встановлена швидкість
let _rateTimer = null;  // таймер плавної рампи

// Один крок LERP до target
function _stepRate(target) {
  const clamped = Math.max(1 - _SYNC_MAX, Math.min(1 + _SYNC_MAX, target));
  const diff    = clamped - _rate;
  if (Math.abs(diff) < _SYNC_DEAD) return;
  _rate += diff * _SYNC_LERP;
  if (sourceNode?.playbackRate && audioCtx) {
    sourceNode.playbackRate.linearRampToValueAtTime(_rate, audioCtx.currentTime + 0.25);
  }
  _dbRefresh();
}

// Запускає плавний цикл (~12 fps) поки не досягнемо target або sourceNode зникне
function _rampTo(target) {
  if (_rateTimer) { clearInterval(_rateTimer); _rateTimer = null; }
  let steps = 0;
  _rateTimer = setInterval(() => {
    if (!sourceNode || !playing || paused) { clearInterval(_rateTimer); _rateTimer = null; return; }
    _stepRate(target);
    if (++steps > 35 || Math.abs(_rate - target) < _SYNC_DEAD) {
      clearInterval(_rateTimer); _rateTimer = null;
    }
  }, 80);
}

// Скидає rate до 1.0 (при зупинці / паузі / seek)
function _resetRate() {
  _rate = 1.0;
  if (_rateTimer) { clearInterval(_rateTimer); _rateTimer = null; }
  if (sourceNode?.playbackRate && audioCtx) {
    sourceNode.playbackRate.cancelScheduledValues(audioCtx.currentTime);
    sourceNode.playbackRate.setValueAtTime(1.0, audioCtx.currentTime);
  }
  _dbRefresh();
}

// =============================================================================
// Головна функція корекції синхрону
// =============================================================================
//
// СТРАТЕГІЯ:
//   (A) |error| > 150 мс → seek (scheduleAudio) + одразу плавна доводка
//   (B) |error| 20–150 мс → тільки playbackRate, БЕЗ seek
//   (C) |error| 5–20 мс  → мінімальна м'яка корекція
//   (D) |error| < 5 мс   → ідеально, плавно повертаємо до 1.0
//
// КЛЮЧОВІ ВИПРАВЛЕННЯ:
//   1. Один HTTP запит на тік (не 4 як раніше)
//   2. Після seek завжди перезапускаємо таймери (раніше вони вмирали!)
//   3. clockSamples накопичується між тіками — offset стає точнішим з часом
//
// АДАПТАЦІЯ:
//   Після seek: пріоритет — переконатись що все правильно (часті перевірки)
//   При ідеальному синку: збільшуємо паузу до 40 с (економимо HTTP)

let _dbLastErr  = null;  // для debug-панелі
let _dbReqs     = 0;     // лічильник HTTP запитів
let _dbEl       = null;  // DOM елемент панелі
let _dbInterval = '—';   // поточний інтервал

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
  const e = _dbLastErr;
  const errStr = e !== null ? (e >= 0 ? '+' : '') + (e * 1000).toFixed(1) + ' ms' : '—';
  const offStr = (offset >= 0 ? '+' : '') + offset.toFixed(0) + ' ms';
  _dbEl.textContent =
    'err: ' + errStr + '  |  rate: ' + _rate.toFixed(4) +
    '  |  clk: ' + offStr + '  |  Δt: ' + _dbInterval + '  |  HTTP: ' + _dbReqs;
}

async function checkAndCorrect() {
  if (!playing || paused || startTime === null) return;

  // ОДИН HTTP запит — оновлює offset (не 4 як раніше!)
  const t0  = Date.now();
  const res = await fetch(`${WORKER_URL}/room/${roomId}/time`).catch(() => null);
  _dbReqs++;
  if (!res?.ok) return;
  addSample((await res.json()).serverTime, t0);

  const targetPos = (serverNow() - startTime) / 1000;
  const actualPos = getActualPos();

  // sourceNode зник (ще не стартував або вже закінчився)
  if (actualPos === null) {
    scheduleAudio();
    schedulePostStartCorrections(); // відновлюємо таймери
    return;
  }

  const error    = targetPos - actualPos;
  const absError = Math.abs(error);
  _dbLastErr = error;
  _dbRefresh();

  // (A) Великий рассинхрон: seek + плавна доводка
  if (absError > 0.150) {
    _resetRate();
    scheduleAudio();
    schedulePostStartCorrections(); // ← КРИТИЧНО: після seek таймери треба перезапустити
    return;
  }
  // (B) Середній: тільки playbackRate
  if (absError > 0.020) {
    _rampTo(1 + Math.max(-_SYNC_MAX, Math.min(_SYNC_MAX, error / _SYNC_WINDOW)));
    return;
  }
  // (C) Малий: одна м'яка корекція
  if (absError > 0.005) {
    _stepRate(1 + Math.max(-_SYNC_MAX, Math.min(_SYNC_MAX, error / _SYNC_WINDOW)));
    return;
  }
  // (D) Ідеально: повільно повертаємо до 1.0
  _stepRate(1.0);
}

// =============================================================================
// Адаптивний планувальник синхронізації
// =============================================================================
//
// ЕКОНОМІЯ ЗАПИТІВ:
//   Старий код: resync(3) + checkAndCorrect() кожні 10 с = 4 HTTP/тік
//   Новий код:  checkAndCorrect() з адаптивним інтервалом = 1 HTTP/тік
//
//   При ідеальному синку (< 5 мс) інтервал зростає до 40 с.
//   При дрейфі > 50 мс — повертається до 1 с.
//
//   Кількість запитів за 4-хв пісню:
//   Старий: ~100 HTTP  |  Новий: ~15–25 HTTP  (залежно від якості мережі)

let correctionTimers = [];
let _syncTimeout     = null;   // setTimeout (не setInterval — бо адаптивний)
let _syncConsecOk    = 0;      // кількість послідовних "ідеальних" циклів
let _syncMs          = 2000;   // поточний інтервал (мс)
// Перемикачі для пришвидшення першого входу в синк
let _syncFastPhase   = false;  // true = режим швидкого входу
let _syncFastCount   = 0;      // кількість швидких тіків після seek

function schedulePostStartCorrections() {
  correctionTimers.forEach(t => clearTimeout(t));
  correctionTimers = [];
  // Після старту або seek: режим швидкого входу (часті перевірки)
  _syncFastPhase = true;
  _syncFastCount = 0;
  _syncConsecOk  = 0;
  _syncMs        = 1000;
  // Перша перевірка через 2.5 с (пісня точно вже грає)
  correctionTimers.push(setTimeout(() => checkAndCorrect(), 2500));
  startPeriodicSync();
}

function startPeriodicSync() {
  stopPeriodicSync();

  async function tick() {
    if (!playing || paused) { _next(5000); return; }
    await checkAndCorrect();

    const absErr = _dbLastErr !== null ? Math.abs(_dbLastErr) : 0.1;

    if (_syncFastPhase) {
      // Режим швидкого входу: перші 6 тіків після старту/seek
      // Мета: швидко увійти в синк за 5–8 секунд
      _syncFastCount++;
      if (absErr < 0.010) {
        _syncConsecOk++;
        _syncMs = 1500; // вже добре, злегка розгальмовуємо
      } else {
        _syncConsecOk = 0;
        _syncMs = absErr > 0.050 ? 800 : 1200; // ще коригується
      }
      if (_syncFastCount >= 6) {
        _syncFastPhase = false; // виходимо з режиму швидкого входу
        _syncMs = 3000;
      }
    } else {
      // Звичайний режим: адаптуємо інтервал по помилці
      if (absErr < 0.005) {
        // Ідеально → збільшуємо паузу (економимо HTTP)
        _syncConsecOk++;
        if      (_syncConsecOk >= 15) _syncMs = Math.min(_syncMs * 1.5, 40000); // до 40 с
        else if (_syncConsecOk >= 8)  _syncMs = Math.min(_syncMs * 1.3, 20000); // до 20 с
        else                          _syncMs = Math.min(_syncMs * 1.1, 8000);  // до 8 с
      } else {
        // Є дрейф → зменшуємо паузу
        _syncConsecOk = 0;
        if      (absErr > 0.050) _syncMs = 1000;
        else if (absErr > 0.020) _syncMs = 2000;
        else                     _syncMs = 4000;
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
  if ('wakeLock' in navigator) {
    try { wakeLock = await navigator.wakeLock.request('screen'); } catch {}
  }
}
function releaseWakeLock() { if (wakeLock) { wakeLock.release(); wakeLock = null; } }
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && playing && !paused) requestWakeLock();
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
  _dbInit();
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
      addSample(msg.serverTime, Date.now() - 30);

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
        // 3 заміри після паузи — достатньо
        await resync(3);
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
                resync(3),
              ]);
              setStatus('');
            } catch (e) {
              setStatus('⚠ ' + e.message); break;
            }
          }
          if (playing && !paused && startTime !== null) {
            // 2 додаткових заміри після завантаження
            await resync(2);
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
    // Хост: 3 заміри — є 3 секунди запасу, достатньо для ±10 мс
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
          resync(3),
        ]);
        setStatus('');
      } catch (e) {
        stopNode(); clearBuffer();
        setStatus('⚠ ' + e.message);
        return;
      }
    }
    // Після завантаження — 2 додаткових заміри (вже є 3 з паралельного)
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
