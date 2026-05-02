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
  // SAFETY_OFFSET — невеликий буфер щоб компенсувати затримку виконання
  const off     = Math.min(elapsed + SAFETY_OFFSET, audioBuffer.duration - 0.01);
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
  let ws = 0, os = 0;
  for (const s of use) { const w = minRtt / s.rtt; ws += w; os += s.off * w; }
  const newOffset = os / ws;
  if (clockSamples.length <= 1) {
    // Перший замір після скидання — довіряємо повністю (offset ще не має сенсу)
    offset = newOffset;
  } else {
    // Один стабільний коефіцієнт 80/20 — передбачувано і достатньо
    const blended = offset * 0.8 + newOffset * 0.2;
    // Clamp: не більше 20ms зміни за один крок — захист від різких стрибків
    const step    = Math.max(-20, Math.min(20, blended - offset));
    offset        = offset + step;
  }
}

// Початкова синхронізація при вході
async function syncOnEntry(id) {
  for (let i = 0; i < 3; i++) {
    const t0  = Date.now();
    const res = await fetch(`${WORKER_URL}/room/${id}/time`).catch(() => null);
    if (res?.ok) addSample((await res.json()).serverTime, t0);
    if (i < 2) await new Promise(r => setTimeout(r, 50));
  }
}

// Точна синхронізація перед стартом аудіо
// 4 заміри з паузою 30ms — достатньо точно, вкладається в 3с запас startTime
// Скидаємо clockSamples тільки якщо музика не грає —
// під час відтворення скидання дасть різкий стрибок offset → хибний drift
async function preSync() {
  if (!playing) clockSamples = []; // скидаємо тільки на старті, не під час гри
  for (let i = 0; i < 4; i++) {
    const t0  = Date.now();
    const res = await fetch(`${WORKER_URL}/room/${roomId}/time`).catch(() => null);
    if (res?.ok) {
      addSample((await res.json()).serverTime, t0);
      requestState.lastRequestTime = Date.now();
    }
    if (i < 3) await new Promise(r => setTimeout(r, 30));
  }
}

// Поточна позиція відтворення в секундах
function getActualPos() {
  if (!sourceNode || !audioCtx) return null;
  const elapsed = audioCtx.currentTime - sourceNode._when;
  // ВАЖЛИВО: враховуємо playbackRate — без цього drift вимірюється неправильно
  const rate    = sourceNode.playbackRate?.value ?? 1.0;
  return sourceNode._off + elapsed * rate;
}

// =============================================================================
// Adaptive Predictive Sync
// =============================================================================
const SAFETY_OFFSET = 0.03; // 30ms — достатньо для інтернету

const syncState = {
  driftHistory:       [],
  smoothedRate:       1.0,
  skipNext:           false,
  lastRestartTime:    0,
  longTermDrift:      0,
  largeDriftCount:    0,     // скільки разів поспіль drift > 40ms
  pendingRestart:     false, // перший великий drift → чекаємо підтвердження
  stableCount:        0,     // скільки разів поспіль drift < 15ms (інерція)
  lastExpected:       null,  // попереднє expected — захист від стрибка offset
};

const requestState = {
  stabilityScore:  50,
  lastDrift:       0,
  lastRequestTime: 0,
  minInterval:     5000,
  maxInterval:     45000,
};

const urgencyState = {
  level:         0,
  lastSpikeTime: 0,
};

let syncLoopTimer = null;

function _weightedAverage(values) {
  let sum = 0, weightSum = 0;
  values.forEach((v, i) => { const w = i + 1; sum += v * w; weightSum += w; });
  return weightSum === 0 ? 0 : sum / weightSum;
}
function _jitter(interval) { return interval * (0.9 + Math.random() * 0.2); }

function updateUrgency(drift, driftRate) {
  const absDrift = Math.abs(drift);
  const now      = Date.now();
  if      (absDrift > 40) urgencyState.level += 50;
  else if (absDrift > 20) urgencyState.level += 30;
  else if (absDrift < 8)  urgencyState.level -= 10;
  if (Math.abs(driftRate) > 2) {
    urgencyState.level        += 10;
    urgencyState.lastSpikeTime = now;
  }
  if (now - urgencyState.lastSpikeTime > 5000) urgencyState.level -= 5;
  urgencyState.level = Math.max(0, Math.min(100, urgencyState.level));
}

function updateStability(drift, prevDrift) {
  const absDrift   = Math.abs(drift);
  const driftDelta = Math.abs(drift - prevDrift);
  if      (absDrift < 8)  requestState.stabilityScore += 3;
  else if (absDrift < 20) requestState.stabilityScore += 1;
  else                    requestState.stabilityScore -= 15;
  if (driftDelta > 10)    requestState.stabilityScore -= 5;
  requestState.stabilityScore = Math.max(0, Math.min(100, requestState.stabilityScore));
  requestState.lastDrift = drift;
}

function shouldRequest(forcedByDrift) {
  if (forcedByDrift) return true;
  const score   = requestState.stabilityScore;
  const urgency = urgencyState.level;
  // Жорстке блокування при високій стабільності і низькому urgency
  if (score > 85 && urgency < 5) {
    if (Date.now() - requestState.lastRequestTime < 30000) return false;
  }
  const elapsed        = Date.now() - requestState.lastRequestTime;
  const effectiveScore = Math.max(0, Math.min(100, score - urgency));
  const base           = requestState.minInterval +
                         (requestState.maxInterval - requestState.minInterval) *
                         (effectiveScore / 100);
  return elapsed >= _jitter(base);
}

function calcTargetRate(driftRate) {
  // Корекція тільки від швидкості зміни дрейфу (ms/sec), не від абсолютного drift
  // driftRate > 0 → клієнт все більше випереджає → треба сповільнити
  // driftRate < 0 → клієнт все більше відстає   → треба прискорити
  // Множник 0.00005: при driftRate = 10ms/s корекція = 0.05% — майже непомітно
  const raw        = -(driftRate * 0.00005);
  const correction = Math.max(-0.005, Math.min(0.005, raw)); // clamp ±0.5%
  let   targetRate = 1.0 + correction;
  // Мертва зона: корекція < 0.4% → встановлюємо рівно 1.0
  // Уникає постійних мікроколивань від шуму вимірювань
  if (Math.abs(targetRate - 1.0) < 0.004) targetRate = 1.0;
  return targetRate;
}

function applyPlaybackRate(rate) {
  if (!sourceNode) return;
  sourceNode.playbackRate.setTargetAtTime(rate, audioCtx.currentTime, 0.5);
}

function localCorrection() {
  if (syncState.skipNext || !playing || paused || startTime === null) return;
  const actual = getActualPos();
  if (actual === null) return;
  // Якщо offset застарів — тільки дуже повільне повернення до 1.0
  const isStale = (Date.now() - requestState.lastRequestTime) > 15000;
  if (isStale) {
    syncState.smoothedRate = syncState.smoothedRate + (1.0 - syncState.smoothedRate) * 0.02;
    applyPlaybackRate(syncState.smoothedRate);
    return;
  }
  const expected = (serverNow() - startTime) / 1000;
  const drift    = (actual - expected) * 1000;
  const absDrift = Math.abs(drift);
  // Мертва зона 15ms — при малому drift нічого не робимо
  if (absDrift < 15) {
    syncState.smoothedRate = syncState.smoothedRate + (1.0 - syncState.smoothedRate) * 0.05;
    applyPlaybackRate(syncState.smoothedRate);
    return;
  }
  // Є помітний drift але немає свіжого серверного заміру —
  // тільки дуже слабке наближення до 1.0, без активної корекції
  syncState.smoothedRate = syncState.smoothedRate + (1.0 - syncState.smoothedRate) * 0.03;
  applyPlaybackRate(syncState.smoothedRate);
}

async function adaptiveSyncLoop() {
  if (!playing || paused || startTime === null) { scheduleNext(); return; }
  const actual = getActualPos();
  if (actual === null) { scheduleNext(); return; }

  const roughDrift       = (actual - (serverNow() - startTime) / 1000) * 1000;
  const smoothedForForce = syncState.driftHistory.length > 0
    ? _weightedAverage(syncState.driftHistory.map(h => h.drift)) : roughDrift;
  const forcedRequest    = Math.abs(smoothedForForce) > 30;

  if (!shouldRequest(forcedRequest)) {
    localCorrection();
    scheduleNext();
    return;
  }

  // Один запит на сервер
  const t0  = Date.now();
  const res = await fetch(`${WORKER_URL}/room/${roomId}/time`).catch(() => null);
  if (!res?.ok) {
    requestState.stabilityScore = Math.max(0, requestState.stabilityScore - 10);
    urgencyState.level          = Math.min(100, urgencyState.level + 20);
    localCorrection();
    scheduleNext();
    return;
  }
  addSample((await res.json()).serverTime, t0);
  requestState.lastRequestTime = Date.now();

  if (syncState.skipNext) { syncState.skipNext = false; scheduleNext(); return; }

  // Offset щойно оновлений — isStale тут завжди false, але перевіряємо захисно
  const isStale = (Date.now() - requestState.lastRequestTime) > 15000;
  if (isStale) { scheduleNext(); return; }

  const expected  = (serverNow() - startTime) / 1000;
  const actualNow = getActualPos();
  if (actualNow === null) { scheduleNext(); return; }

  const drift    = (actualNow - expected) * 1000;
  const absDrift = Math.abs(drift);

  // Захист від шумного виміру: якщо expected різко стрибнув або drift аномальний
  // — не додаємо в driftHistory, але продовжуємо цикл (не пропускаємо)
  const prevExp    = syncState.lastExpected ?? expected;
  const expJump    = Math.abs((expected - prevExp) * 1000);
  syncState.lastExpected = expected;
  const isNoisy    = (expJump > 40 && syncState.driftHistory.length > 0)
                  || (absDrift > 80 && syncState.stableCount > 3);
  if (!isNoisy) {
    syncState.driftHistory.push({ drift, timestamp: Date.now() });
    if (syncState.driftHistory.length > 8) syncState.driftHistory.shift();
  }

  const smoothedDrift = _weightedAverage(syncState.driftHistory.map(h => h.drift));
  const history       = syncState.driftHistory;
  let   driftRate     = history.length >= 2
    ? (history[history.length-1].drift - history[0].drift) /
      ((history[history.length-1].timestamp - history[0].timestamp) / 1000)
    : 0;
  driftRate = Math.max(-50, Math.min(50, driftRate)); // clamp аномальні значення

  // Оновлюємо longTermDrift — дуже повільна адаптація
  syncState.longTermDrift = syncState.longTermDrift +
    (smoothedDrift - syncState.longTermDrift) * 0.02;

  updateStability(drift, requestState.lastDrift);
  updateUrgency(drift, driftRate);

  // Рішення приймаємо за smoothedDrift (згладжений), не за сирим drift
  // Один шумний вимір не змінить smoothedDrift суттєво
  const absSmoothed = Math.abs(smoothedDrift);

  if (absSmoothed < 15) {
    // Мертва зона — дуже повільно до 1.0
    syncState.largeDriftCount = 0;
    syncState.pendingRestart  = false;
    syncState.stableCount     = Math.min(syncState.stableCount + 1, 20);
    syncState.smoothedRate    = syncState.smoothedRate + (1.0 - syncState.smoothedRate) * 0.05;
    applyPlaybackRate(syncState.smoothedRate);

  } else if (absSmoothed <= 40) {
    // Середній drift — слабка корекція через driftRate
    // Інерція: якщо система довго була стабільна → ще повільніша реакція
    syncState.largeDriftCount = 0;
    syncState.pendingRestart  = false;
    const inertia    = syncState.stableCount > 5 ? 0.04 : 0.08;
    syncState.stableCount = 0;
    const targetRate = calcTargetRate(driftRate);
    syncState.smoothedRate = syncState.smoothedRate +
      (targetRate - syncState.smoothedRate) * inertia;
    applyPlaybackRate(syncState.smoothedRate);

  } else {
    // Великий drift — потрібне підтвердження перед restart
    syncState.stableCount = 0;
    syncState.largeDriftCount += 1;

    if (!syncState.pendingRestart) {
      // Перший раз бачимо великий drift — ставимо флаг і чекаємо наступного циклу
      syncState.pendingRestart = true;
      syncState.smoothedRate   = syncState.smoothedRate + (1.0 - syncState.smoothedRate) * 0.05;
      applyPlaybackRate(syncState.smoothedRate);
    } else if (syncState.largeDriftCount >= 2) {
      // Підтверджено мінімум двома вимірами поспіль → restart
      const now        = Date.now();
      const canRestart = (now - syncState.lastRestartTime) > 3000;
      if (canRestart) {
        syncState.lastRestartTime = now;
        syncState.skipNext        = true;
        syncState.largeDriftCount = 0;
        syncState.pendingRestart  = false;
        urgencyState.level          = Math.min(100, urgencyState.level + 40);
        requestState.stabilityScore = Math.max(0, requestState.stabilityScore - 20);
        syncState.smoothedRate = 1.0;
        scheduleAudio();
        applyPlaybackRate(1.0);
      } else {
        // Cooldown — чекаємо
        syncState.smoothedRate = syncState.smoothedRate + (1.0 - syncState.smoothedRate) * 0.05;
        applyPlaybackRate(syncState.smoothedRate);
      }
    } else {
      // largeDriftCount = 1, pendingRestart = true — чекаємо ще один цикл
      syncState.smoothedRate = syncState.smoothedRate + (1.0 - syncState.smoothedRate) * 0.05;
      applyPlaybackRate(syncState.smoothedRate);
    }
  }

  scheduleNext();
}

function scheduleNext() {
  if (syncLoopTimer) clearTimeout(syncLoopTimer);
  const effectiveScore = Math.max(0, Math.min(100,
    requestState.stabilityScore - urgencyState.level));
  const base    = requestState.minInterval +
                  (requestState.maxInterval - requestState.minInterval) *
                  (effectiveScore / 100);
  syncLoopTimer = setTimeout(adaptiveSyncLoop, _jitter(base));
}

function startAdaptiveSyncLoop() {
  if (syncLoopTimer) clearTimeout(syncLoopTimer);
  // Рандомний старт 2–5с — щоб клієнти не били сервер одночасно
  syncLoopTimer = setTimeout(adaptiveSyncLoop, 2000 + Math.random() * 3000);
}

function stopAdaptiveSyncLoop() {
  if (syncLoopTimer) clearTimeout(syncLoopTimer);
  syncLoopTimer = null;
}

// =============================================================================
// Wake Lock
// =============================================================================
async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  // Не запитуємо повторно якщо вже активний
  if (wakeLock && !wakeLock.released) return;
  try { wakeLock = await navigator.wakeLock.request('screen'); } catch {}
}
function releaseWakeLock() {
  // Хост тримає wake lock постійно — не відпускаємо під час сесії
  if (role === 'host') return;
  if (wakeLock) { wakeLock.release(); wakeLock = null; }
}
document.addEventListener('visibilitychange', () => {
  // Браузер скасовує wake lock при переході вкладки у фон —
  // відновлюємо як тільки вкладка знову стає активною.
  // Для хоста — завжди; для клієнта — тільки під час відтворення.
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
  headerToggle.addEventListener('click', async () => {
    isMuted = !isMuted;
    if (gainNode) gainNode.gain.value = isMuted ? 0 : 1;
    updateSpeakerUI();
    // Якщо вмикаємо звук під час відтворення — синхронізуємось
    if (!isMuted && syncAudioEnabled && audioUnlocked && playing && !paused && startTime !== null) {
      await preSync(); scheduleAudio(); startAdaptiveSyncLoop();
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
      // Не додаємо зразок з joined — RTT WebSocket невідомий, фіктивне 30ms спотворює offset

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
        requestWakeLock(); // хост: тримаємо екран активним увесь час сесії

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
      stopAdaptiveSyncLoop();
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
        await preSync();
        scheduleAudio();
        startAdaptiveSyncLoop();
      }
      break;
    }

    // ── Stop ─────────────────────────────────────────────────────────────────
    case 'stop': {
      playing = false; paused = false; startTime = null;
      stopAdaptiveSyncLoop();
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
              await ensureBuffer(currentSong);
              setStatus('');
            } catch (e) {
              setStatus('⚠ ' + e.message); break;
            }
          }
          if (playing && !paused && startTime !== null) {
            await preSync();
            scheduleAudio();
            startAdaptiveSyncLoop();
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
    await preSync();
    scheduleAudio();
    startAdaptiveSyncLoop();

  } else if (syncAudioEnabled && audioUnlocked && !isMuted) {
    if (!audioBuffer || currentSong !== song) {
      stopNode();
      clearBuffer();
      setStatus('⏳ Завантаження…');
      try {
        await ensureBuffer(song);
        setStatus('');
      } catch (e) {
        stopNode(); clearBuffer();
        setStatus('⚠ ' + e.message);
        return;
      }
    }
    await preSync();
    scheduleAudio();
    startAdaptiveSyncLoop();
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
  // preSync тут — щоб offset був свіжим ДО відправки команди
  // Хост і клієнт матимуть менший розрив між своїми serverNow() в момент scheduleAudio()
  await preSync();
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
