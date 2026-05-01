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
  _rate = 1.0;  // скидаємо після кожного (пере)запуску
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

// Початкова синхронізація при вході
async function syncOnEntry(id) {
  for (let i = 0; i < 4; i++) {
    const t0  = Date.now();
    const res = await fetch(`${WORKER_URL}/room/${id}/time`).catch(() => null);
    _httpN++;
    if (res?.ok) addSample((await res.json()).serverTime, t0);
    if (i < 3) await new Promise(r => setTimeout(r, 40));
  }
}

// Послідовні заміри — повертає найкращий offset
// Використовуємо паралельні + послідовні для швидкості та точності
async function resync(count = 3) {
  for (let i = 0; i < count; i++) {
    const t0  = Date.now();
    const res = await fetch(`${WORKER_URL}/room/${roomId}/time`).catch(() => null);
    _httpN++;
    if (res?.ok) addSample((await res.json()).serverTime, t0);
    if (i < count - 1) await new Promise(r => setTimeout(r, 35));
  }
}

// =============================================================================
// Поточна позиція (audioCtx.currentTime — стабільний, без jitter)
// =============================================================================
function getActualPos() {
  if (!sourceNode || !audioCtx) return null;
  return sourceNode._off + (audioCtx.currentTime - sourceNode._when);
}

// =============================================================================
// Learned Rate — "пам'ять пристрою" в localStorage
// =============================================================================
// Кожен пристрій має мікроскопічний drift oscillator-а.
// Ми вимірюємо середній error і зберігаємо "ідеальну" швидкість.
// Наступна сесія одразу стартує з правильним rate — без зайвих корекцій.
// Зберігається між перезавантаженнями сторінки.

const _LS_KEY = 'karaoke_lr';   // learned rate
const _LS_ERR = 'karaoke_le';   // last stable error для debug

function _lrRead() {
  try {
    const v = parseFloat(localStorage.getItem(_LS_KEY) || '1');
    return (isFinite(v) && v >= 0.990 && v <= 1.010) ? v : 1.0;
  } catch { return 1.0; }
}

// EMA-оновлення: alpha=0.10 — повільне, стабільне навчання
// Оновлюємо тільки якщо error стабільний (variance мала) — не навчаємось на jitter
function _lrWrite(observedError) {
  const cur  = _lrRead();
  // error у секундах → корекція rate (ділимо на 60: 1 мс/хв = 0.0000167)
  const upd  = cur + (observedError / 60.0) * 0.10;
  const safe = Math.max(0.990, Math.min(1.010, upd));
  try {
    localStorage.setItem(_LS_KEY, safe.toFixed(7));
    localStorage.setItem(_LS_ERR, (observedError * 1000).toFixed(2));
  } catch {}
  return safe;
}

// =============================================================================
// Кільцевий буфер останніх вимірів drift
// =============================================================================
// Зберігає 8 значень error. Дає:
//   trend    — куди дрейфує пристрій (середнє)
//   variance — jitter чи реальний drift

const _DB = [];  // drift buffer: останні 8 error (секунди)

function _dbPush(e)  { _DB.push(e); if (_DB.length > 8) _DB.shift(); }
function _dbTrend()  { if (_DB.length < 2) return null; return _DB.reduce((a,b)=>a+b,0)/_DB.length; }
function _dbVar()    {
  if (_DB.length < 2) return 999;
  const m = _dbTrend();
  return _DB.reduce((a,b)=>a+(b-m)**2,0)/_DB.length;
}

// =============================================================================
// Адаптивний playbackRate
// =============================================================================
// Формула: target = blend(errorRate, learnedRate)
//   errorRate  = 1 + clamp(effectiveError / 6.0, -0.02, +0.02)
//   learnedRate = з localStorage
//   effectiveError = 0.65*current + 0.35*trend (якщо trend стабільний)
//
// Зміна через linearRampToValueAtTime — плавно, без клацань.

let _rate     = 1.0;        // поточна встановлена швидкість
let _lr       = 1.0;        // learned rate (завантажується при старті)
let _rTimer   = null;       // таймер рампи

function _applyRate(target) {
  const c = Math.max(0.980, Math.min(1.020, target));
  const d = c - _rate;
  if (Math.abs(d) < 0.0004) return;      // мертва зона — ігноруємо мікрозміни
  _rate += d * 0.18;                     // LERP: плавне наближення
  if (sourceNode?.playbackRate && audioCtx)
    sourceNode.playbackRate.linearRampToValueAtTime(_rate, audioCtx.currentTime + 0.4);
  _panelUpdate();
}

function _rampRate(target) {
  if (_rTimer) { clearInterval(_rTimer); _rTimer = null; }
  let n = 0;
  _rTimer = setInterval(() => {
    if (!sourceNode || !playing || paused) { clearInterval(_rTimer); _rTimer = null; return; }
    _applyRate(target);
    if (++n > 40 || Math.abs(_rate - target) < 0.0004) { clearInterval(_rTimer); _rTimer = null; }
  }, 80);
}

function _resetRate() {
  _rate = 1.0;
  if (_rTimer) { clearInterval(_rTimer); _rTimer = null; }
  if (sourceNode?.playbackRate && audioCtx) {
    sourceNode.playbackRate.cancelScheduledValues(audioCtx.currentTime);
    sourceNode.playbackRate.setValueAtTime(1.0, audioCtx.currentTime);
  }
  _panelUpdate();
}

function _targetRate(error) {
  const trend = _dbTrend();
  // Зважуємо поточний error і тренд (тільки якщо trend стабільний)
  const eff = (trend !== null && _dbVar() < 0.0003)
    ? error * 0.65 + trend * 0.35
    : error;
  const errRate = 1 + Math.max(-0.020, Math.min(0.020, eff / 6.0));
  // Зважений баланс errorRate і learnedRate
  return Math.max(0.980, Math.min(1.020, errRate * 0.6 + _lr * 0.4));
}

// =============================================================================
// Debug-панель
// =============================================================================
let _panel = null, _httpN = 0, _lastErr = null, _lastDt = '—';

function _panelInit() {
  _panel = document.createElement('div');
  _panel.style.cssText = [
    'position:fixed','bottom:4px','left:0','right:0','text-align:center',
    'font-size:10px','color:#888','pointer-events:none','z-index:9999',
    'font-family:monospace','letter-spacing:0.02em',
  ].join(';');
  document.body.appendChild(_panel);
  _panelUpdate();
}

function _panelUpdate() {
  if (!_panel) return;
  const e  = _lastErr;
  const es = e !== null ? (e>=0?'+':'')+(e*1000).toFixed(1)+' ms' : '—';
  const tr = _dbTrend();
  const ts = tr !== null ? (tr>=0?'+':'')+(tr*1000).toFixed(1) : '—';
  _panel.textContent =
    'err:'+es+'  trend:'+ts+'ms  rate:'+_rate.toFixed(5)+
    '  lr:'+_lr.toFixed(5)+'  clk:'+(offset>=0?'+':'')+offset.toFixed(0)+'ms'+
    '  Δt:'+_lastDt+'  HTTP:'+_httpN;
}

// =============================================================================
// Головна функція корекції
// =============================================================================
// Стратегія по рівнях error:
//
//   > 30 мс  → seek одразу (ривок, непомітний на слух) + перезапуск таймерів
//              КРИТИЧНО: без перезапуску таймерів синхронізація вмирає!
//   8–30 мс  → _rampRate: плавний цикл наближення
//   2–8 мс   → _applyRate: один крок корекції
//   < 2 мс   → _applyRate(learnedRate): тримаємо базову швидкість пристрою
//
// Learned rate оновлюється кожен тік при стабільному error (variance < 0.0003).
// Це "пам'ять" — наступна сесія стартує вже з правильним rate.

async function checkAndCorrect() {
  if (!playing || paused || startTime === null) return;

  const t0  = Date.now();
  const res = await fetch(`${WORKER_URL}/room/${roomId}/time`).catch(() => null);
  _httpN++;
  if (!res?.ok) return;
  addSample((await res.json()).serverTime, t0);

  const tgt = (serverNow() - startTime) / 1000;
  const act = getActualPos();

  if (act === null) { await scheduleAudio(); schedulePostStartCorrections(); return; }

  const err   = tgt - act;   // + = відстаємо, − = поспішаємо
  const abErr = Math.abs(err);

  _dbPush(err);
  _lastErr = err;

  // Оновлюємо learned rate тільки при стабільному дрейфі (не jitter)
  if (_DB.length >= 4 && _dbVar() < 0.0003) _lr = _lrWrite(err);

  _panelUpdate();

  // Seek при великому рассинхроні
  if (abErr > 0.030) {
    _resetRate();
    await scheduleAudio();
    schedulePostStartCorrections();   // ← без цього таймери вмирають!
    return;
  }

  // Плавна корекція швидкістю
  const rt = _targetRate(err);
  if      (abErr > 0.008) _rampRate(rt);
  else if (abErr > 0.002) _applyRate(rt);
  else                    _applyRate(_lr);   // ідеально — learned rate як база
}

// =============================================================================
// Адаптивний планувальник (геометричне зростання інтервалу)
// =============================================================================
//
// ЛОГІКА ІНТЕРВАЛІВ:
//
//   Фаза 1 — "вхід у синк" (перші ~10 с після старту/seek):
//     Кожен тік при error > 10 мс: залишаємось на 1 с
//     При error < 10 мс: переходимо до фази 2
//
//   Фаза 2 — "стабілізація" (геометричне зростання ×2):
//     1с → 2с → 4с → 8с → 16с → 32с → 60с (макс)
//     Якщо error > 15 мс: скидаємось до 2с
//     Якщо error > 30 мс: seek + скид до фази 1
//
//   Кількість HTTP на 4-хв пісню:
//     Ідеальна мережа:  ~12–16  (entry 4 + стабілізація ~8)
//     Звичайна мережа:  ~20–30
//     Погана мережа:    ~40–50 (але синк все одно тримається)
//
// Порівняно зі старим кодом (120+ HTTP): економія 75–90%.

let correctionTimers   = [];
let _syncTid           = null;  // поточний setTimeout
let _syncMs            = 1000;  // поточний інтервал
let _stableCount       = 0;     // скільки разів поспіль error < 10 мс
let _inEntryPhase      = true;  // true = "вхід у синк", false = "стабілізація"

function schedulePostStartCorrections() {
  correctionTimers.forEach(t => clearTimeout(t));
  correctionTimers = [];
  _stableCount    = 0;
  _inEntryPhase   = true;
  _syncMs         = 1000;
  // Перша перевірка через 2.5 с (пісня вже точно грає)
  correctionTimers.push(setTimeout(() => checkAndCorrect(), 2500));
  startPeriodicSync();
}

function startPeriodicSync() {
  stopPeriodicSync();

  async function tick() {
    if (!playing || paused) { _schedule(6000); return; }
    await checkAndCorrect();

    const abErr = _lastErr !== null ? Math.abs(_lastErr) : 0.1;

    if (_inEntryPhase) {
      // Фаза входу: тримаємось на 1 с доки error < 10 мс кілька разів поспіль
      if (abErr < 0.010) {
        _stableCount++;
        if (_stableCount >= 3) {
          // Переходимо до фази стабілізації
          _inEntryPhase = false;
          _syncMs = 2000;  // стартуємо з 2 с
        }
      } else {
        _stableCount = 0;
        _syncMs = 1000;  // error ще великий — залишаємось на 1 с
      }
    } else {
      // Фаза стабілізації: геометричне зростання ×2
      if (abErr < 0.010) {
        // Добре — подвоюємо інтервал (геометрична прогресія)
        _syncMs = Math.min(_syncMs * 2, 60000);  // макс 60 с
      } else if (abErr > 0.030) {
        // Великий error: seek вже зроблений у checkAndCorrect, скидаємось до фази входу
        _inEntryPhase = true;
        _stableCount  = 0;
        _syncMs       = 1000;
      } else if (abErr > 0.010) {
        // Середній error: скидаємось до 2 с
        _syncMs = 2000;
      }
      // Якщо abErr < 0.010 — продовжуємо подвоювати
    }

    _lastDt = _syncMs >= 1000 ? (_syncMs/1000).toFixed(0)+'s' : _syncMs+'ms';
    _panelUpdate();
    _schedule(_syncMs);
  }

  function _schedule(ms) { _syncTid = setTimeout(() => tick().catch(console.error), ms); }
  _schedule(_syncMs);
}

function stopPeriodicSync() {
  if (_syncTid) { clearTimeout(_syncTid); _syncTid = null; }
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
function releaseWakeLock() {
  if (role === 'host') return;  // хост тримає wake lock постійно
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
  _panelInit();
  _lr = _lrRead();  // завантажуємо learned rate — пристрій одразу знає свою швидкість
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
        requestWakeLock();

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

      // Скидаємо drift history при новій пісні; перезавантажуємо learned rate
      _DB.length = 0;
      _lr = _lrRead();
      _httpN = 0;
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
            // Після завантаження — 2 додаткових заміри
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
          resync(3),
        ]);
        setStatus('');
      } catch (e) {
        stopNode(); clearBuffer();
        setStatus('⚠ ' + e.message);
        return;
      }
    }
    // Після завантаження — 2 додаткових заміри
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
