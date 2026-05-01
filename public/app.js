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
  _rate = 1.0; _smoothE = 0; // скидаємо після кожного (пере)запуску
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
    _dbReqs++;
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
    _dbReqs++;
    if (res?.ok) addSample((await res.json()).serverTime, t0);
    if (i < count - 1) await new Promise(r => setTimeout(r, 35));
  }
}

// =============================================================================
// Поточна позиція аудіо
// =============================================================================
// audioCtx.currentTime — монотонний лічильник без jitter Event Loop.
function getActualPos() {
  if (!sourceNode || !audioCtx) return null;
  return sourceNode._off + (audioCtx.currentTime - sourceNode._when);
}

// =============================================================================
// Learned Rate — пам'ять пристрою між сесіями (localStorage)
// =============================================================================
// Кожен телефон має мікроскопічний drift oscillator-а (±50–200 ppm).
// Ми накопичуємо виміряний середній error і зберігаємо "базову" швидкість.
// При наступному запуску пристрій одразу стартує з правильним rate.
//
// Алгоритм: EMA з alpha=0.08 (дуже повільне навчання — не реагує на jitter).
// Оновлюється тільки коли variance останніх вимірів мала (стабільний drift).

const _LR_KEY = 'k_lr2';  // localStorage key

function _lrGet() {
  try {
    const v = parseFloat(localStorage.getItem(_LR_KEY) || '1');
    return (isFinite(v) && v >= 0.9950 && v <= 1.0050) ? v : 1.0;
  } catch { return 1.0; }
}

function _lrSet(errorSec) {
  // Перетворюємо error у поправку rate.
  // Ділимо на велике число (120) — дуже повільна адаптація.
  // Це захищає від перенавчання при тимчасових збоях мережі.
  const cur = _lrGet();
  const upd = cur + (errorSec / 120.0) * 0.08;
  const v   = Math.max(0.9950, Math.min(1.0050, upd));
  try { localStorage.setItem(_LR_KEY, v.toFixed(8)); } catch {}
  return v;
}

// =============================================================================
// Статистика drift (ковзне вікно 6 вимірів)
// =============================================================================
// Зберігаємо останні 6 вимірів error (секунди).
// median()  — стійкий до викидів (jitter не псує картину)
// variance() — дисперсія: мала = стабільний drift, велика = jitter

const _W = [];  // вікно вимірів

function _wPush(e)    { _W.push(e); if (_W.length > 6) _W.shift(); }
function _wMedian()   {
  if (!_W.length) return 0;
  const s = [..._W].sort((a,b) => a-b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m-1]+s[m])/2;
}
function _wVariance() {
  if (_W.length < 2) return 999;
  const mn = _W.reduce((a,b)=>a+b,0)/_W.length;
  return _W.reduce((a,b)=>a+(b-mn)**2,0)/_W.length;
}

// =============================================================================
// Плавна корекція playbackRate (без перерегулювання)
// =============================================================================
//
// ГОЛОВНА ПРИЧИНА "скачків" у попередній версії:
//   Система бачила error +15 мс → встановлювала rate 1.005 → за 3 с
//   надолужувала +15 мс, але за цей час приходив новий вимір і
//   знову ставила rate — перелітала в -8 мс. Цикл повторювався.
//
// РІШЕННЯ — двокрокова корекція:
//
//   Крок 1: розраховуємо СКІЛЬКИ треба скоригувати (не rate, а delta позиції)
//     correctionSec = smoothedError (EMA від кількох вимірів)
//
//   Крок 2: ділимо корекцію на ВІКНО КОРЕКЦІЇ (часовий горизонт)
//     rate = 1 + correctionSec / windowSec
//     window = 8 с (дуже повільно, але без перельоту)
//
//   Крок 3: rate НЕ міняємо до наступного виміру.
//     Він діє весь інтервал між перевірками (Δt).
//     Коли Δt велике (30–60 с) — вікно корекції збільшується автоматично.
//
//   Результат: система "знає" що за windowSec вона виправить помилку
//   рівно на correctionSec — без перельоту.
//
// МЕРТВА ЗОНА: ±10 мс рахується "добре" — rate не змінюємо взагалі.
// LEARNED RATE: базова швидкість = learnedRate пристрою.
//   target = learnedRate + correctionSec / window

let _lr      = 1.0;   // learned rate, завантажується при старті
let _rate    = 1.0;   // поточний встановлений rate
let _smoothE = 0;     // EMA від error (для плавності)
let _rTimer  = null;  // таймер рампи

// Встановлює rate через linearRamp (плавно, без артефактів)
function _setRate(r) {
  const safe = Math.max(0.980, Math.min(1.020, r));
  if (Math.abs(safe - _rate) < 0.00005) return;  // мікрозміна — ігноруємо
  _rate = safe;
  if (sourceNode?.playbackRate && audioCtx) {
    // Рампа на 1 с — повільна, непомітна зміна швидкості
    sourceNode.playbackRate.linearRampToValueAtTime(_rate, audioCtx.currentTime + 1.0);
  }
  _dbRefresh();
}

function _resetRate() {
  _rate    = 1.0;
  _smoothE = 0;
  if (_rTimer) { clearInterval(_rTimer); _rTimer = null; }
  if (sourceNode?.playbackRate && audioCtx) {
    sourceNode.playbackRate.cancelScheduledValues(audioCtx.currentTime);
    sourceNode.playbackRate.setValueAtTime(1.0, audioCtx.currentTime);
  }
  _dbRefresh();
}

// Обчислює і встановлює правильний rate на основі error і Δt
// intervalSec — час до наступної перевірки (секунди)
function _calcAndSetRate(errorSec, intervalSec) {
  // EMA від error: alpha=0.4 — достатньо швидка реакція, але без шуму
  _smoothE = _smoothE * 0.6 + errorSec * 0.4;

  // Мертва зона ±10 мс: вважаємо "ідеально" — тільки learned rate
  if (Math.abs(_smoothE) < 0.010) {
    _setRate(_lr);
    return;
  }

  // Вікно корекції = MAX(intervalSec * 2, 8 с)
  // Якщо Δt велике (30 с) — вікно 60 с → дуже плавна корекція
  // Якщо Δt мале (1 с) — вікно 8 с → трохи швидша, але все одно плавна
  const window = Math.max(intervalSec * 2, 8);

  // target = learnedRate + поправка
  // Поправка = smoothedError / window (наскільки відхилитись від норми)
  const correction = Math.max(-0.015, Math.min(0.015, _smoothE / window));
  _setRate(_lr + correction);
}

// =============================================================================
// Debug-панель
// =============================================================================
let _dbEl  = null, _dbReqs = 0, _dbLastE = null, _dbDt = '—';

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
  const e  = _dbLastE;
  const es = e !== null ? (e>=0?'+':'')+(e*1000).toFixed(1)+' ms' : '—';
  const ms = (e !== null && Math.abs(e) <= 0.010) ? ' ✓' : '';
  _dbEl.textContent =
    'err: '+es+ms+
    '  smooth: '+(_smoothE*1000).toFixed(1)+'ms'+
    '  rate: '+_rate.toFixed(6)+
    '  lr: '+_lr.toFixed(6)+
    '  clk: '+(offset>=0?'+':'')+offset.toFixed(0)+'ms'+
    '  Δt: '+_dbDt+
    '  HTTP: '+_dbReqs;
}

// =============================================================================
// Головна функція корекції
// =============================================================================
//
// Рівні реакції:
//   |error| > 80 мс  → seek (одноразовий ривок, потім плавна корекція)
//   |error| ≤ 80 мс  → тільки rate (ніяких seek, плавно)
//   |error| ≤ 10 мс  → "добре", rate = learnedRate (без корекції)
//
// Learned rate оновлюється при стабільному дрейфі (variance мала).
// Це накопичується між сесіями — телефон стає точнішим з часом.

async function checkAndCorrect(intervalSec) {
  if (!playing || paused || startTime === null) return;

  const t0  = Date.now();
  const res = await fetch(`${WORKER_URL}/room/${roomId}/time`).catch(() => null);
  _dbReqs++;
  if (!res?.ok) return;
  addSample((await res.json()).serverTime, t0);

  const tgt = (serverNow() - startTime) / 1000;
  const act = getActualPos();
  if (act === null) { await scheduleAudio(); schedulePostStartCorrections(); return; }

  const err   = tgt - act;
  const abErr = Math.abs(err);

  _wPush(err);
  _dbLastE = err;

  // Оновлюємо learned rate тільки при стабільному дрейфі
  if (_W.length >= 4 && _wVariance() < 0.0002) _lr = _lrSet(_wMedian());

  _dbRefresh();

  // Seek тільки при дуже великому рассинхроні
  if (abErr > 0.080) {
    _smoothE = 0;  // скидаємо EMA — нова точка відліку
    _resetRate();
    await scheduleAudio();
    schedulePostStartCorrections();  // ← КРИТИЧНО: відновлюємо таймери
    return;
  }

  // Плавна корекція rate (без seek)
  _calcAndSetRate(err, intervalSec || 4);
}

// =============================================================================
// Адаптивний планувальник
// =============================================================================
//
// Геометрична прогресія × 2 при стабільному синці:
//   Фаза входу (|err| > 10 мс):  1 с між перевірками
//   Стабілізація (|err| ≤ 10 мс): 2→4→8→16→32→60 с
//
// Ключова відмінність від попереднього: передаємо intervalSec в
// checkAndCorrect щоб rate розраховувався на правильний горизонт часу.
//
// HTTP за 4-хв пісню: ~10–20 (залежно від якості мережі)

let correctionTimers = [];
let _syncTid         = null;
let _syncMs          = 1000;
let _stableN         = 0;    // к-сть поспіль "гарних" тіків
let _entryPhase      = true; // true = вхід у синк (часто), false = стабільно

function schedulePostStartCorrections() {
  correctionTimers.forEach(t => clearTimeout(t));
  correctionTimers = [];
  _stableN    = 0;
  _entryPhase = true;
  _syncMs     = 1000;
  // Перша перевірка через 2.5 с
  correctionTimers.push(setTimeout(() => checkAndCorrect(1), 2500));
  startPeriodicSync();
}

function startPeriodicSync() {
  stopPeriodicSync();

  async function tick() {
    if (!playing || paused) { _next(6000); return; }

    const intervalSec = _syncMs / 1000;
    await checkAndCorrect(intervalSec);

    const abE = _dbLastE !== null ? Math.abs(_dbLastE) : 0.1;
    const good = abE <= 0.010;  // ±10 мс = "добре"

    if (_entryPhase) {
      if (good) { _stableN++; }
      else      { _stableN = 0; _syncMs = 1000; }
      // Виходимо з фази входу після 3 гарних тіків поспіль
      if (_stableN >= 3) { _entryPhase = false; _syncMs = 2000; }
    } else {
      if (good) {
        // Геометрична прогресія × 2, максимум 60 с
        _syncMs = Math.min(_syncMs * 2, 60000);
      } else if (abE > 0.080) {
        // Seek вже виконано → скидаємось до фази входу
        _entryPhase = true; _stableN = 0; _syncMs = 1000;
      } else {
        // Середній error → повертаємось до 2 с (не до 1 с — без паніки)
        _syncMs = 2000;
      }
    }

    _dbDt = _syncMs >= 1000 ? (_syncMs/1000).toFixed(0)+'s' : _syncMs+'ms';
    _dbRefresh();
    _next(_syncMs);
  }

  function _next(ms) { _syncTid = setTimeout(() => tick().catch(console.error), ms); }
  _next(_syncMs);
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
  _lr = _lrGet();
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

      _W.length = 0; _smoothE = 0; _lr = _lrGet(); _dbReqs = 0;
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
            // Після завантаження — ще заміри для точного старту "на льоту"
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
    // Після завантаження — ще 4 заміри вже з точним offset
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
