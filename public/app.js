// =============================================================================
// Karaoke – frontend v4 
// =============================================================================
const WORKER_URL = 'https://pisni.slovo-wiry.workers.dev';
'use strict';

// =============================================================================
// DEBUG SYNC SYSTEM
// Set DEBUG_SYNC = true to enable. Zero overhead when false.
// =============================================================================
const DEBUG_SYNC = false; // set to true to enable sync debug panel and logging
const _DBG_START  = Date.now(); // session start for external timestamp use

const _dbg = (() => {
  if (!DEBUG_SYNC) {
    // Return no-op stubs — no overhead
    const noop = () => {};
    return { log: noop, event: noop, initPanel: noop };
  }

  const MAX_ENTRIES  = 1000;
  const SESSION_START = Date.now();
  const buffer       = [];
  let   panelEl      = null;
  let   panelBody    = null;
  let   uiTimer      = null;

  function ts() {
    const s = ((Date.now() - SESSION_START) / 1000).toFixed(1);
    return `+${s}s`;
  }

  let _clientLabel = 'host'; // updated after role is known

  function setLabel(label) { _clientLabel = label; }

  function log(line) {
    // Prefix every line with client label so merged logs are identifiable
    const tagged = `[${_clientLabel}] ${line}`;
    buffer.push(tagged);
    if (buffer.length > MAX_ENTRIES) buffer.shift();
  }

  function event(label, data) {
    const parts = [ts(), `[${label}]`];
    if (data) parts.push(data);
    log(parts.join(' '));
  }

  function scheduleUiUpdate() {
    if (uiTimer || !panelBody) return;
    uiTimer = setTimeout(() => {
      uiTimer = null;
      if (!panelBody) return;
      const last50 = buffer.slice(-50).join('\n');
      panelBody.textContent = last50;
      panelBody.scrollTop   = panelBody.scrollHeight;
    }, 1000);
  }

  function initPanel() {
    if (panelEl) return;

    panelEl = document.createElement('div');
    Object.assign(panelEl.style, {
      position:   'fixed',
      bottom:     '0',
      right:      '0',
      width:      '340px',
      height:     '220px',
      background: 'rgba(0,0,0,0.88)',
      color:      '#0f0',
      fontSize:   '10px',
      fontFamily: 'monospace',
      zIndex:     '99999',
      display:    'flex',
      flexDirection: 'column',
      borderTopLeftRadius: '6px',
      overflow:   'hidden',
    });

    // Header bar
    const header = document.createElement('div');
    Object.assign(header.style, {
      display:    'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      padding:    '3px 6px',
      background: 'rgba(0,255,0,0.15)',
      flexShrink: '0',
    });
    header.innerHTML = '<span>⚡ sync debug</span>';

    const btnRow = document.createElement('div');
    btnRow.style.display = 'flex';
    btnRow.style.gap     = '4px';

    const copyBtn = document.createElement('button');
    copyBtn.textContent = 'Copy';
    Object.assign(copyBtn.style, {
      fontSize:   '9px',
      padding:    '1px 5px',
      cursor:     'pointer',
      background: '#1a1',
      color:      '#fff',
      border:     'none',
      borderRadius: '3px',
    });
    copyBtn.onclick = () => {
      navigator.clipboard.writeText(buffer.join('\n'))
        .then(() => { copyBtn.textContent = 'Copied!'; setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500); })
        .catch(() => { copyBtn.textContent = 'Error'; });
    };

    const clearBtn = document.createElement('button');
    clearBtn.textContent = 'Clear';
    Object.assign(clearBtn.style, {
      fontSize:   '9px',
      padding:    '1px 5px',
      cursor:     'pointer',
      background: '#441',
      color:      '#fff',
      border:     'none',
      borderRadius: '3px',
    });
    clearBtn.onclick = () => { buffer.length = 0; if (panelBody) panelBody.textContent = ''; };

    const hideBtn = document.createElement('button');
    hideBtn.textContent = '✕';
    Object.assign(hideBtn.style, {
      fontSize:   '9px',
      padding:    '1px 5px',
      cursor:     'pointer',
      background: 'transparent',
      color:      '#888',
      border:     'none',
    });
    hideBtn.onclick = () => { panelEl.style.display = 'none'; };

    btnRow.appendChild(copyBtn);
    btnRow.appendChild(clearBtn);
    btnRow.appendChild(hideBtn);
    header.appendChild(btnRow);

    // Log body
    panelBody = document.createElement('pre');
    Object.assign(panelBody.style, {
      flex:       '1',
      margin:     '0',
      padding:    '4px 6px',
      overflowY:  'auto',
      overflowX:  'hidden',
      whiteSpace: 'pre-wrap',
      wordBreak:  'break-all',
      fontSize:   '9.5px',
    });

    panelEl.appendChild(header);
    panelEl.appendChild(panelBody);
    document.body.appendChild(panelEl);
  }

  function getBuffer() {
    const out = buffer.splice(0); // drain: send and clear
    return out;
  }
  return { log, event, scheduleUiUpdate, initPanel, setLabel, getBuffer };
})();


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
let globalVolume   = 0.8; // 0.0 – 1.0, synced from host
let sourceNode     = null;
let audioBuffer    = null;   // завантажений буфер ТІЛЬКИ поточної пісні
let audioBufferMode = null;  // noWordsMode, з якою завантажено поточний audioBuffer
let loadingSong    = null;   // яка пісня зараз завантажується (щоб не дублювати)
let audioUnlocked  = false;  // user gesture відбувся
let isMuted        = false;

// Без слів (акапело)
// false (за умовчанням) — грає файл "<song>1.mp3" (зі словами)
// true                   — грає файл "<song>.mp3"  (акапело, без слів)
let noWordsMode = false;

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
const noWordsLabel = $('no-words-label');
const noWordsCheck = $('no-words-check');
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
  gainNode.gain.value = isMuted ? 0 : globalVolume;
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

// Ім'я mp3-файлу для пісні залежно від режиму "без слів":
// noWordsMode = true  -> "<song>.mp3"  (акапело, поточний файл, без слів)
// noWordsMode = false -> "<song>1.mp3" (та сама мелодія, зі словами)
function audioFileName(song) {
  return noWordsMode ? song : (song + '1');
}

// Завантажує MP3. Якщо вже завантажений (та сама пісня і той самий режим) — повертає кеш.
// FIX: скидає audioBuffer якщо пісня або режим (без слів / зі словами) змінились
async function ensureBuffer(song) {
  const mode = noWordsMode;
  // Вже є правильний буфер
  if (audioBuffer && currentSong === song && audioBufferMode === mode) return audioBuffer;
  // Якщо буфер від іншої пісні або іншого режиму — скидаємо
  if (audioBuffer && (currentSong !== song || audioBufferMode !== mode)) audioBuffer = null;
  initAudio();
  loadingSong = song;
  const file = audioFileName(song);
  try {
    const res = await fetch('/songs/' + song + '/' + file + '.mp3');
    if (!res.ok) throw new Error('MP3 not found: ' + file);
    const arr = await res.arrayBuffer();
    if (loadingSong !== song) throw new Error('Song changed during load');
    audioBuffer = await new Promise((ok, fail) => audioCtx.decodeAudioData(arr, ok, fail));
    audioBufferMode = mode;
    loadingSong = null;
    return audioBuffer;
  } catch (e) {
    loadingSong = null;
    audioBuffer = null;
    audioBufferMode = null;
    throw e;
  }
}

function clearBuffer() {
  audioBuffer = null;
  audioBufferMode = null;
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
  // When catching up (msUntil < 0): recalculate elapsed right before src.start()
  // to account for time spent in this function (preSync ~300ms, AudioContext ops).
  // When starting in future (msUntil > 0): use normal calculation.
  let off, when;
  if (msUntil >= 0) {
    // Starting in the future — schedule precisely
    off  = 0;
    when = audioCtx.currentTime + msUntil / 1000;
  } else {
    // Already past startTime — recalculate elapsed at the last possible moment
    // to minimize the gap between calculation and actual src.start()
    const elapsedNow = Math.max(0, (serverNow() - startTime) / 1000);
    off  = Math.min(elapsedNow, audioBuffer.duration - 0.01);
    when = audioCtx.currentTime + 0.005;
  }
  if (off >= audioBuffer.duration) return;
  const src = audioCtx.createBufferSource();
  src.buffer = audioBuffer;
  src._when  = when;
  src._off   = off;
  gainNode.gain.value = isMuted ? 0 : globalVolume;
  src.connect(gainNode);
  src.start(when, off);
  // Record wall clock and ctx time anchor for throttle detection
  syncState.ctxAnchorWall    = Date.now();
  syncState.ctxAnchorCtx     = audioCtx.currentTime;
  syncState.ctxThrottleRatio = 1.0;
  // Keep ctxSamples rolling — don't reset on restart so freeze detection stays active
  // But push current point as the new anchor for the long-term ratio
  if (!syncState.ctxSamples) syncState.ctxSamples = [];
  syncState.ctxSamples.push({ wall: Date.now(), ctx: audioCtx.currentTime });
  if (DEBUG_SYNC) _dbg.event('scheduleAudio', `off=${off.toFixed(3)}s when=${when.toFixed(3)} startTime=${startTime} offset=${offset.toFixed(1)}ms`);
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
  const rawOff = srvTime - (t0 + rtt / 2);

  // Sanity check: discard only truly impossible values (>24h difference)
  // 24h covers any timezone mismatch — a device with wrong timezone has a stable
  // but shifted Date.now(). We should accept it and use the offset as-is.
  // Values beyond 24h suggest a broken clock or corrupted response.
  const MAX_OFFSET = 86400000; // 24 hours in ms
  if (Math.abs(rawOff) > MAX_OFFSET) {
    if (DEBUG_SYNC) _dbg.event('offset-BAD', `discarded rawOff=${rawOff.toFixed(0)}ms rtt=${rtt}ms`);
    return;
  }

  // Also discard if RTT looks like a timeout (>2000ms) — server was unreachable
  if (rtt > 2000) {
    if (DEBUG_SYNC) _dbg.event('offset-BAD', `discarded rtt=${rtt}ms`);
    return;
  }

  clockSamples.push({ off: rawOff, rtt });
  if (clockSamples.length > 12) clockSamples.shift();
  const sorted  = [...clockSamples].sort((a, b) => a.rtt - b.rtt);
  const use     = sorted.slice(0, Math.max(1, Math.floor(sorted.length * 0.7)));
  const minRtt  = use[0].rtt;
  let ws = 0, os = 0;
  for (const s of use) { const w = minRtt / s.rtt; ws += w; os += s.off * w; }
  const newOffset = os / ws;

  const prevOff = offset;
  if (clockSamples.length <= 1 && offset === 0) {
    // Very first sample ever — no prior reference, trust fully
    offset = newOffset;
    if (DEBUG_SYNC) _dbg.event('offset', `${prevOff.toFixed(1)}→${offset.toFixed(1)}ms (first)`);
  } else {
    // Always use EMA — even for first sample after reset if we have prior offset.
    // This prevents a single high/low outlier from dominating the result.
    // 50/50 blend for first few samples (more responsive), then 80/20
    const alpha   = clockSamples.length <= 2 ? 0.5 : 0.2;
    const blended = offset * (1 - alpha) + newOffset * alpha;
    const step    = Math.max(-40, Math.min(40, blended - offset));
    offset        = offset + step;
    if (DEBUG_SYNC) {
      const delta = offset - prevOff;
      if (Math.abs(delta) > 1) _dbg.event('offset', `${prevOff.toFixed(1)}→${offset.toFixed(1)}ms (Δ${delta > 0 ? '+' : ''}${delta.toFixed(1)})`);
    }
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
  if (DEBUG_SYNC) _dbg.event('preSync', `start offset=${offset.toFixed(1)}ms playing=${playing}`);
  // Reset clockSamples on start, or if offset is absurd (>24h — broken device clock)
  // Do NOT zero offset on corrupt reset — keep previous value as best estimate
  // until new valid samples arrive. Zeroing causes exp=-3528s nonsense.
  if (!playing || Math.abs(offset) > 86400000) {
    clockSamples = [];
    if (Math.abs(offset) > 86400000) {
      if (DEBUG_SYNC) _dbg.event('preSync', `offset absurd (${offset.toFixed(0)}ms), resetting samples`);
      // Keep offset as-is — new samples will correct it via EMA
    }
  }
  for (let i = 0; i < 6; i++) {
    const t0  = Date.now();
    const res = await fetch(`${WORKER_URL}/room/${roomId}/time`).catch(() => null);
    if (res?.ok) {
      addSample((await res.json()).serverTime, t0);
      requestState.lastRequestTime = Date.now();
    }
    if (i < 5) await new Promise(r => setTimeout(r, 30));
  }
  if (DEBUG_SYNC) _dbg.event('preSync', `end offset=${offset.toFixed(1)}ms`);
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
  largeDriftCount:    0,
  pendingRestart:     false,
  stableCount:        0,
  lastOffset:         null,
  lastSmdSign:        0,
  // AudioContext throttle detection
  ctxAnchorWall:      null,  // Date.now() at last scheduleAudio
  ctxAnchorCtx:       null,  // audioCtx.currentTime at last scheduleAudio
  ctxThrottleRatio:   1.0,   // actualCtxRate / expectedCtxRate (1.0 = perfect)
  // Rolling window for short-term freeze detection (5-10s window)
  ctxSamples:         [],    // [{wall, ctx}] — last N samples for recent ratio
};

const requestState = {
  stabilityScore:  0,   // starts at 0 — fast initial cycles, builds up over time
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

function calcTargetRate(driftRate, smoothedDrift) {
  // Primary: driftRate contribution — reacts to growing drift
  // At driftRate=10ms/s → correction=0.05% (inaudible)
  const rateRaw  = -(driftRate * 0.00005);

  // Secondary: weak direct smoothedDrift term — closes stable non-zero offset
  // At smoothedDrift=20ms → correction=0.001 (closes 20ms gap in ~2 minutes)
  // At smoothedDrift=5ms  → correction=0.00025 (below dead zone, ignored)
  // This is intentionally tiny — avoids oscillation, just prevents permanent drift
  const driftRaw = -(smoothedDrift * 0.00005);

  const correction = Math.max(-0.005, Math.min(0.005, rateRaw + driftRaw));
  let   targetRate = 1.0 + correction;

  // Dead zone: correction < 0.1% → set exactly 1.0
  // Reduced from 0.4% — that was too aggressive and suppressed valid corrections
  if (Math.abs(targetRate - 1.0) < 0.001) targetRate = 1.0;
  return targetRate;
}

function applyPlaybackRate(rate) {
  if (!sourceNode) return;
  sourceNode.playbackRate.setTargetAtTime(rate, audioCtx.currentTime, 0.5);
}

// Fast seek without HTTP request — used when offset is fresh and drift is large.
// iOS AudioContext freezes ~67ms every 10-40s. We detect this in localCorrection
// (called every animation frame at 60fps) and fix it in <100ms without waiting
// for the next adaptiveSyncLoop cycle (which could be 5-15s away).
let _lastFastSeek = 0;

function localCorrection() {
  if (syncState.skipNext || !playing || paused || startTime === null) return;
  const actual = getActualPos();
  if (actual === null) return;

  const offsetAge = Date.now() - requestState.lastRequestTime;
  const isStale   = offsetAge > 15000;

  if (isStale) {
    syncState.smoothedRate = syncState.smoothedRate + (1.0 - syncState.smoothedRate) * 0.02;
    applyPlaybackRate(syncState.smoothedRate);
    return;
  }

  const expected = (serverNow() - startTime) / 1000;
  const drift    = (actual - expected) * 1000;
  const absDrift = Math.abs(drift);

  // ── Fast seek (no HTTP) ─────────────────────────────────────────────────────
  // If drift > 25ms but offset is fresh (<5s old): seek immediately without preSync.
  // iOS freeze is always ~67ms — we can correct it in one frame using existing offset.
  // Cooldown 2s to prevent seek loops if something is wrong.
  const now = Date.now();
  if (absDrift >= 25 && absDrift < 150 && offsetAge < 5000 &&
      (now - _lastFastSeek) > 2000 &&
      (now - syncState.lastRestartTime) > 1000) {
    _lastFastSeek = now;
    syncState.lastRestartTime = now;
    syncState.driftHistory   = [];
    syncState.stableCount    = 0;
    syncState.pendingRestart = false;
    syncState.smoothedRate   = 1.0;
    if (DEBUG_SYNC) _dbg.event('FAST-SEEK',
      `drift=${drift.toFixed(1)}ms off_age=${offsetAge}ms`);
    scheduleAudio(); // reseek using current (fresh) offset — no HTTP needed
    applyPlaybackRate(1.0);
    return;
  }

  if (absDrift < 6) {
    // Dead zone — return to 1.0
    syncState.smoothedRate = syncState.smoothedRate + (1.0 - syncState.smoothedRate) * 0.05;
    applyPlaybackRate(syncState.smoothedRate);
    return;
  }
  if (absDrift < 25) {
    // Rate correction
    const rateCorrection   = Math.max(-0.005, Math.min(0.005, -drift * 0.00005));
    const targetRate       = Math.max(0.995, Math.min(1.005, 1.0 + rateCorrection));
    syncState.smoothedRate = syncState.smoothedRate * 0.8 + targetRate * 0.2;
    applyPlaybackRate(syncState.smoothedRate);
    return;
  }
  // Large drift, stale offset or too soon after last seek — nudge slowly
  syncState.smoothedRate = syncState.smoothedRate + (1.0 - syncState.smoothedRate) * 0.03;
  applyPlaybackRate(syncState.smoothedRate);
}

async function adaptiveSyncLoop() {
  if (!playing || paused || startTime === null) { scheduleNext(); return; }

  // Detect AudioContext suspension (tab backgrounded / screen locked on iOS/Android).
  // When suspended, audioCtx.currentTime freezes → getActualPos() returns stale value.
  if (audioCtx && audioCtx.state === 'suspended') {
    try { await audioCtx.resume(); } catch {}
    if (DEBUG_SYNC) _dbg.event('audioCtx', 'suspended — resumed, rescheduling');
    syncState.driftHistory = [];
    await preSync();
    scheduleAudio();
    scheduleNext();
    return;
  }

  const actual = getActualPos();
  if (actual === null) { scheduleNext(); return; }

  const roughDrift       = (actual - (serverNow() - startTime) / 1000) * 1000;
  const smoothedForForce = syncState.driftHistory.length > 0
    ? _weightedAverage(syncState.driftHistory.map(h => h.drift)) : roughDrift;
  const forcedRequest    = Math.abs(smoothedForForce) > 30;

  if (!shouldRequest(forcedRequest)) {
    if (DEBUG_SYNC) {
      const _act = getActualPos();
      const _exp = startTime !== null ? (serverNow() - startTime) / 1000 : 0;
      const _d   = _act !== null ? ((_act - _exp) * 1000).toFixed(1) : 'n/a';
      const _sd  = syncState.driftHistory.length > 0
        ? _weightedAverage(syncState.driftHistory.map(h => h.drift)).toFixed(1) : '—';
      _dbg.log(`${((Date.now()-_DBG_START)/1000).toFixed(1)}s [cycle] no-req | drift=${_d} smd=${_sd} rate=${syncState.smoothedRate.toFixed(4)} stab=${requestState.stabilityScore} urg=${urgencyState.level|0}`);
      _dbg.scheduleUiUpdate();
    }
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
  // Detect noisy measurement by comparing offset change between cycles,
  // NOT expected change. expected grows naturally with time — comparing it
  // always produces large "jumps". offset should be stable between cycles.
  const prevOffset  = syncState.lastOffset ?? offset;
  const offsetJump  = Math.abs(offset - prevOffset);
  syncState.lastOffset = offset;
  // Only offset jump is a reliable noise signal.
  // absDrift > 80 was incorrectly filtering real large drifts as noise.
  // Detect AudioContext freeze: smd near zero but raw drift suddenly huge
  // This happens when AudioContext suspends briefly (iOS/Android background)
  // In this case treat as a restart trigger, not noise
  const audioCtxFroze = Math.abs(drift) > 50 && Math.abs(smoothedForForce) < 10;
  const isNoisy    = (offsetJump > 20 && syncState.driftHistory.length > 0) && !audioCtxFroze;
  if (!isNoisy) {
    syncState.driftHistory.push({ drift, timestamp: Date.now() });
    if (syncState.driftHistory.length > 8) syncState.driftHistory.shift();
  }

  const smoothedDrift = _weightedAverage(syncState.driftHistory.map(h => h.drift));
  const history       = syncState.driftHistory;
  // driftRate from last 3 entries only — reflects current trend, not historical average
  // Using first-to-last spans minutes and produces stale/reversed rate values
  let   driftRate = 0;
  if (history.length >= 2) {
    const tail   = history.slice(-3); // last 3 (or fewer if history is short)
    const dtMs   = tail[tail.length-1].timestamp - tail[0].timestamp;
    if (dtMs > 0) {
      driftRate = (tail[tail.length-1].drift - tail[0].drift) / (dtMs / 1000);
    }
  }
  driftRate = Math.max(-50, Math.min(50, driftRate)); // clamp аномальні значення

  // Оновлюємо longTermDrift — дуже повільна адаптація
  syncState.longTermDrift = syncState.longTermDrift +
    (smoothedDrift - syncState.longTermDrift) * 0.02;

  // Urgency decay завжди — незалежно від якості виміру
  if (Date.now() - urgencyState.lastSpikeTime > 5000) {
    urgencyState.level = Math.max(0, urgencyState.level - 5);
  }
  // Stability і urgency штрафи — тільки якщо вимір не шумний
  if (!isNoisy) {
    updateStability(drift, requestState.lastDrift);
    updateUrgency(drift, driftRate);
  } else {
    // Навіть при шумному вимірі — дуже повільне повернення rate до 1.0
    // Запобігає "замороженню" корекції на ненульовому значенні
    if (DEBUG_SYNC) _dbg.log(`${((Date.now()-_DBG_START)/1000).toFixed(1)}s [cycle] NOISY | offJump=${offsetJump.toFixed(1)} drift=${drift.toFixed(1)} rate=${syncState.smoothedRate.toFixed(4)}`);
    syncState.smoothedRate = syncState.smoothedRate + (1.0 - syncState.smoothedRate) * 0.02;
    applyPlaybackRate(syncState.smoothedRate);
    if (DEBUG_SYNC) _dbg.scheduleUiUpdate();
    scheduleNext();
    return;
  }

  // Рішення приймаємо за smoothedDrift (згладжений), не за сирим drift
  // Один шумний вимір не змінить smoothedDrift суттєво
  const absSmoothed = Math.abs(smoothedDrift);

  if (DEBUG_SYNC) {
    const _a25 = absSmoothed >= 25 || Math.abs(drift) > 40;
    const _a6  = absSmoothed >= 6  || Math.abs(drift) > 20;
    const _thr = syncState.ctxThrottleRatio < 0.995;
    const _decision = !_a6 ? 'idle'
      : (!_a25 && !_thr) ? 'rate-fix'
      : (syncState.pendingRestart ? 'restart(pending)' : 'restart(first)');
    _dbg.log(`${((Date.now()-_DBG_START)/1000).toFixed(1)}s [cycle] req | off=${offset.toFixed(1)} exp=${expected.toFixed(3)} act=${actualNow.toFixed(3)} drift=${drift.toFixed(1)} smd=${smoothedDrift.toFixed(1)} dRate=${driftRate.toFixed(2)} rate=${syncState.smoothedRate.toFixed(4)} dec=${_decision} stab=${requestState.stabilityScore} urg=${urgencyState.level|0}`);
    _dbg.scheduleUiUpdate();
  }

  // ── Detect AudioContext throttling ─────────────────────────────────────────
  // TWO detection methods:
  // 1. Long-term EMA ratio (catches gradual throttle)
  // 2. Short rolling window ~6s (catches iOS sudden freeze of 100-130ms)
  //
  // iOS pattern: ctx freezes suddenly for 100-130ms every 25-65s
  // This shows up as ratio ~0.97 in a 5s window but ~0.999 in a 60s window
  // → need short window to catch it

  const nowWall = Date.now();
  const nowCtx  = audioCtx ? audioCtx.currentTime : null;

  if (nowCtx !== null && syncState.ctxAnchorWall !== null) {
    // Push new sample to rolling window
    syncState.ctxSamples.push({ wall: nowWall, ctx: nowCtx });
    // Keep only samples from last 4 seconds — shorter window catches brief freezes better
    // 130ms freeze in 4s window: ratio = (4-0.13)/4 = 0.968 < 0.970 ← catches it
    // 130ms freeze in 8s window: ratio = (8-0.13)/8 = 0.984 > 0.980 ← missed
    const cutoff = nowWall - 4000;
    syncState.ctxSamples = syncState.ctxSamples.filter(s => s.wall >= cutoff);

    // Long-term ratio (from scheduleAudio anchor)
    const wallLong = (nowWall - syncState.ctxAnchorWall) / 1000;
    const ctxLong  = nowCtx - syncState.ctxAnchorCtx;
    if (wallLong > 2.0) {
      const ratioLong = ctxLong / wallLong;
      syncState.ctxThrottleRatio = syncState.ctxThrottleRatio * 0.8 + ratioLong * 0.2;
    }

    // Short-term ratio (rolling window — catches sudden freezes)
    let shortRatio = 1.0;
    if (syncState.ctxSamples.length >= 2) {
      const oldest  = syncState.ctxSamples[0];
      const wallShort = (nowWall - oldest.wall) / 1000;
      const ctxShort  = nowCtx - oldest.ctx;
      if (wallShort >= 1.0) { // Need at least 1s
        shortRatio = ctxShort / wallShort;
      }
    }

    if (DEBUG_SYNC) {
      const longBad  = syncState.ctxThrottleRatio < 0.995;
      const shortBad = shortRatio < 0.980;
      if (longBad || shortBad) {
        _dbg.event('ctx-throttle',
          `long=${syncState.ctxThrottleRatio.toFixed(4)} short=${shortRatio.toFixed(4)}`);
      }
    }

    // Ignore throttle in first 3s after scheduleAudio — ctx starts slow after creation
    const timeSinceSchedule = syncState.ctxAnchorWall ? (nowWall - syncState.ctxAnchorWall) : 0;
    const throttleReady = timeSinceSchedule > 3000;
    // Throttled if EITHER long-term OR short-term ratio is bad
    // 0.970 threshold: catches 130ms freeze in 4s window (ratio=0.968)
    var isThrottled = throttleReady && (syncState.ctxThrottleRatio < 0.995 || shortRatio < 0.970);
  } else {
    var isThrottled = false;
  }

  // ── THREE-TIER DECISION ──────────────────────────────────────────────────────
  // Tier 1: Dead zone (|smd| < 3ms) — do nothing, return rate to 1.0
  // Tier 2: Rate correction (3-25ms) — adjust playbackRate to close drift smoothly
  // Tier 3: Restart (>25ms or throttled with large drift) — seek to correct position

  const absSmoothed25 = absSmoothed >= 25 || Math.abs(drift) > 40;
  const absSmoothed6  = absSmoothed >= 6  || Math.abs(drift) > 20;

  if (!absSmoothed6) {
    // ── Tier 1: Dead zone — drift inaudible ─────────────────────────────────
    syncState.largeDriftCount = 0;
    syncState.pendingRestart  = false;
    syncState.lastSmdSign     = 0;
    syncState.stableCount     = Math.min(syncState.stableCount + 1, 20);
    syncState.smoothedRate    = syncState.smoothedRate + (1.0 - syncState.smoothedRate) * 0.05;
    applyPlaybackRate(syncState.smoothedRate);

  } else if (!absSmoothed25 && !isThrottled && absSmoothed6) {
    // ── Tier 2: Rate correction (6-25ms, no throttling) ─────────────────────
    // Adjust playbackRate to close the gap smoothly.
    // Dead zone raised to 6ms: ±5ms is measurement noise on desktop, not real drift.
    syncState.largeDriftCount = 0;
    syncState.pendingRestart  = false;
    syncState.stableCount     = 0;

    // Gentler correction: 0.00005 per ms (was 0.0001) — avoids overshooting
    // At 10ms drift → 0.05% correction → closes 10ms gap in ~20s (inaudible)
    // At 20ms drift → 0.1% correction → closes 20ms gap in ~20s
    const rateCorrection = Math.max(-0.005, Math.min(0.005, -smoothedDrift * 0.00005));
    const targetRate     = 1.0 + rateCorrection;

    // Feed-forward from driftRate — gentler too
    const ffCorrection   = Math.max(-0.001, Math.min(0.001, -driftRate * 0.00002));
    const combinedRate   = Math.max(0.995, Math.min(1.005, targetRate + ffCorrection));

    // Slow EMA blend to prevent oscillation
    syncState.smoothedRate = syncState.smoothedRate * 0.85 + combinedRate * 0.15;
    applyPlaybackRate(syncState.smoothedRate);

    if (DEBUG_SYNC) _dbg.event('rate-fix',
      `smd=${smoothedDrift.toFixed(1)}ms rate=${syncState.smoothedRate.toFixed(4)}`);

  } else {
    // ── Tier 3: Restart — drift too large or ctx throttled ──────────────────
    syncState.stableCount = 0;
    syncState.lastSmdSign = 0;

    const now        = Date.now();
    const canRestart = (now - syncState.lastRestartTime) > 3000;

    const playingForMs     = startTime !== null ? (serverNow() - startTime) : 99999;
    // Skip confirmation if:
    // - first 20s of playback (initial sync)
    // - drift is very large (>50ms) — iOS freeze, no need to wait another cycle
    const skipConfirmation = playingForMs < 20000 || Math.abs(drift) > 50;

    if (!syncState.pendingRestart && !skipConfirmation) {
      syncState.pendingRestart  = true;
      syncState.largeDriftCount = 1;
      syncState.smoothedRate    = syncState.smoothedRate + (1.0 - syncState.smoothedRate) * 0.05;
      applyPlaybackRate(syncState.smoothedRate);

    } else if (canRestart && (skipConfirmation || syncState.pendingRestart)) {
      syncState.lastRestartTime = now;
      syncState.skipNext        = true;
      syncState.largeDriftCount = 0;
      syncState.pendingRestart  = false;
      urgencyState.level          = Math.min(100, urgencyState.level + 20);
      requestState.stabilityScore = Math.max(0, requestState.stabilityScore - 10);
      if (DEBUG_SYNC) _dbg.event('RESTART',
        `smd=${smoothedDrift.toFixed(1)}ms drift=${drift.toFixed(1)}ms throttle=${syncState.ctxThrottleRatio.toFixed(3)}`);
      syncState.driftHistory   = [];
      syncState.stableCount    = 0;
      syncState.pendingRestart = false;
      await preSync();
      scheduleAudio();
      syncState.smoothedRate = 1.0;
      applyPlaybackRate(1.0);

    } else {
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
  // Fast initial cycles: 1.5s → 3s → then normal schedule driven by stabilityScore
  // This detects and corrects initial drift within 5s instead of 20-30s
  // Jitter on first cycle so host+clients don't all hit server at the same ms
  syncLoopTimer = setTimeout(() => {
    adaptiveSyncLoop().then(() => {
      if (syncLoopTimer !== null) {
        syncLoopTimer = setTimeout(adaptiveSyncLoop, 3000 + Math.random() * 1000);
      }
    });
  }, 1500 + Math.random() * 500);
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
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible') {
    // Tab going to background — note the time so we know if AudioContext drifted
    window._hiddenAt = Date.now();
    return;
  }

  // Tab came back to foreground
  if (role === 'host' || (playing && !paused)) requestWakeLock();

  // If audio was playing, AudioContext may have suspended while hidden.
  // Regardless of audioCtx.state, resync position on return.
  // This handles both iOS (ctx suspends) and Android (ctx may drift).
  if (playing && !paused && syncAudioEnabled && audioUnlocked && audioBuffer && !isMuted) {
    const hiddenMs = Date.now() - (window._hiddenAt || Date.now());
    if (hiddenMs > 500) {
      // Was hidden for more than 500ms — AudioContext may have drifted
      if (DEBUG_SYNC) _dbg.event('visibility', `returned after ${hiddenMs}ms — resyncing`);
      if (audioCtx && audioCtx.state === 'suspended') {
        try { await audioCtx.resume(); } catch {}
      }
      syncState.driftHistory = [];
      await preSync();
      scheduleAudio();
      startAdaptiveSyncLoop();
    }
  }
});

// =============================================================================
// Scroll
// =============================================================================
function startScroll() {
  stopScroll();
  (function tick() {
    const diff = targetScrollY - currentScrollY;
    if (Math.abs(diff) > 0.5) {
      // Speed proportional to distance — naturally eases in and out
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
  const containerH = lyricsCont.clientHeight;
  const wordTop    = active.offsetTop;
  const relPos     = wordTop - currentScrollY; // word Y in visible area

  // fraction: 0 = top of visible area, 1 = bottom
  const fraction = Math.max(0, Math.min(1, relPos / containerH));

  // Start scrolling when word passes 20% mark
  if (fraction < 0.20) return;

  // Target: keep word at 20% from top (near second line)
  const newTarget = Math.max(0, wordTop - containerH * 0.20);

  // Linear curve starting from 0 at fraction=0.20, reaching 0.06 at fraction=1.0
  // At fraction=0.30 → 0.006 (barely moves)
  // At fraction=0.50 → 0.018 (gentle)
  // At fraction=0.75 → 0.033 (moderate)
  // At fraction=1.00 → 0.06 (max — slow but steady)
  const excess = fraction - 0.20; // 0..0.8
  const urgency = excess * 0.075; // max = 0.8 * 0.075 = 0.06

  targetScrollY = targetScrollY + (newTarget - targetScrollY) * urgency;
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
    if (gainNode) gainNode.gain.value = isMuted ? 0 : globalVolume;
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
// Apply volume to gainNode and update slider UI
function applyVolume(vol) {
  globalVolume = Math.max(0, Math.min(1, vol));
  if (gainNode && !isMuted) gainNode.gain.value = globalVolume;
  const slider = document.getElementById('volume-slider');
  const label  = document.getElementById('volume-label');
  if (slider) {
    slider.value = Math.round(globalVolume * 100);
    slider.style.setProperty('--vol', slider.value + '%');
  }
  if (label) label.textContent = Math.round(globalVolume * 100) + '%';
}

// Volume slider — host only
(function() {
  const slider = document.getElementById('volume-slider');
  if (!slider) return;
  // Init gradient
  slider.style.setProperty('--vol', slider.value + '%');
  slider.addEventListener('input', () => {
    const vol = parseInt(slider.value) / 100;
    slider.style.setProperty('--vol', slider.value + '%');
    document.getElementById('volume-label').textContent = slider.value + '%';
    applyVolume(vol);
    // Send to all clients via WebSocket
    if (ws && ws.readyState === WebSocket.OPEN && role === 'host') {
      ws.send(JSON.stringify({ type: 'set_volume', volume: vol }));
    }
  });
})();

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
        // Show volume slider for host
        const volRow = document.getElementById('volume-row');
        if (volRow) volRow.hidden = false;
        if (DEBUG_SYNC) {
          _dbg.setLabel('host');
          _dbg.event('role', 'host — debug panel');
          _dbg.initPanel();
        }
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
        // Галочка "Без слів" — завжди знята за умовчанням, не зберігається між сесіями
        noWordsLabel.hidden = false;
        noWordsCheck.checked = false;
        noWordsLabel.classList.remove('on');
        noWordsMode = false;
        if (saved) ws.send(JSON.stringify({ type: 'sync_audio', enabled: true, noWords: noWordsMode }));
        setStatus('Виберіть пісню зі списку нижче.');
        requestWakeLock(); // хост: тримаємо екран активним увесь час сесії

      } else {
        // Клієнт
        if (DEBUG_SYNC) {
          // Use short ID: last 4 chars of clientId for readable label
          const _shortId = getClientId().slice(-4);
          _dbg.setLabel(`c-${_shortId}`);
          _dbg.event('role', `client c-${_shortId} — debug panel`);
          _dbg.initPanel();
          // Flush logs to host every 5 seconds via WebSocket
          setInterval(() => {
            if (!DEBUG_SYNC || role === 'host') return;
            if (!ws || ws.readyState !== WebSocket.OPEN) return;
            const lines = _dbg.getBuffer();
            if (lines.length === 0) return;
            ws.send(JSON.stringify({ type: 'debug_log', lines }));
          }, 5000);
        }
        songPicker.hidden = true; playBtn.hidden = true;
        pauseBtn.hidden = true; syncLabel.hidden = true;
        noWordsLabel.hidden = true;
        lyricsCont.hidden = true;
        syncAudioEnabled = msg.syncAudio || false;
        setHeaderToggle(syncAudioEnabled);
        if (msg.volume !== undefined) applyVolume(msg.volume);
        setStatus('Очікування хоста…');
      }
      break;
    }

    case 'pong':
      break;

    // ── Debug log from client ─────────────────────────────────────────────────
    case 'set_volume': {
      applyVolume(msg.volume ?? 0.8);
      break;
    }

    case 'debug_log': {
      if (!DEBUG_SYNC || role !== 'host') break;
      if (Array.isArray(msg.lines)) {
        msg.lines.forEach(line => _dbg.log(line));
        _dbg.scheduleUiUpdate();
      }
      break;
    }

    // ── Play ─────────────────────────────────────────────────────────────────
    // FIX: завжди оновлюємо currentSong з msg.song — навіть якщо пісня "та сама"
    // щоб клієнт точно знав яку пісню грати
    case 'play': {
      const incomingSong = msg.song;
      startTime          = msg.startTime;
      paused             = false;
      syncAudioEnabled   = msg.syncAudio || false;
      noWordsMode        = !!msg.noWords;

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
    case 'resume': {
      startTime        = msg.startTime;
      paused           = false;
      syncAudioEnabled = msg.syncAudio || false;
      startAnim(); startScroll(); requestWakeLock();
      setStatus('');
      if (role === 'host') { pauseBtn.textContent = '⏸ Пауза'; }
      if (role === 'host') {
        // Host already did preSync before sending resume — just schedule
        scheduleAudio();
        startAdaptiveSyncLoop();
      } else if (syncAudioEnabled && audioUnlocked && audioBuffer && !isMuted) {
        // Clients sync offset fresh, parallel pattern like initial play
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
        noWordsMode = !!msg.noWords;
        // Оновлюємо currentSong якщо worker передав нову пісню
        if (msg.song && msg.song !== currentSong) {
          currentSong = msg.song;
          clearBuffer();
          await loadLyrics(msg.song);
        }

        if (!isMuted && audioUnlocked && currentSong) {
          if (!audioBuffer || audioBufferMode !== noWordsMode) {
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
      noWordsLabel.hidden = false;
      noWordsCheck.checked = noWordsMode;
      noWordsLabel.classList.toggle('on', noWordsMode);
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
  // Reset stability so first sync cycles run at fast interval (5s)
  // After ~30s of stable play, score builds up and intervals lengthen naturally
  requestState.stabilityScore = 0;
  urgencyState.level = 0;
  syncState.driftHistory = [];
  syncState.stableCount  = 0;
  syncState.pendingRestart = false;
  syncState.largeDriftCount = 0;

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
    // preSync already done in playBtn handler before ws.send('play')
    // Doing it again here adds 120ms delay and causes host to start late
    scheduleAudio();
    startAdaptiveSyncLoop();

  } else if (syncAudioEnabled && audioUnlocked && !isMuted) {
    if (!audioBuffer || currentSong !== song || audioBufferMode !== noWordsMode) {
      stopNode();
      clearBuffer();
      setStatus('⏳ Завантаження…');
      try {
        // Load buffer and sync offset in parallel — offset stays fresh
        // regardless of how long the MP3 takes to load
        await Promise.all([ensureBuffer(song), preSync()]);
        setStatus('');
      } catch (e) {
        stopNode(); clearBuffer();
        setStatus('⚠ ' + e.message);
        return;
      }
    } else {
      await preSync();
    }
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
  if (!audioBuffer || currentSong !== song || audioBufferMode !== noWordsMode) {
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
  ws.send(JSON.stringify({ type: 'play', song, noWords: noWordsMode }));
});

pauseBtn?.addEventListener('click', async () => {
  if (!ws || ws.readyState !== WebSocket.OPEN || role !== 'host' || !playing) return;
  if (paused) {
    // Pre-sync offset before resume — same pattern as initial play
    // This ensures host's offset is fresh when scheduleAudio runs
    await preSync();
    ws.send(JSON.stringify({ type: 'resume', song: currentSong }));
  } else {
    ws.send(JSON.stringify({ type: 'pause', song: currentSong }));
  }
});

syncCheck?.addEventListener('change', () => {
  syncLabel.classList.toggle('on', syncCheck.checked);
  syncAudioEnabled = syncCheck.checked;
  if (role === 'host' && ws?.readyState === WebSocket.OPEN) {
    localStorage.setItem('karaoke_sync_audio', syncCheck.checked ? '1' : '0');
    // FIX: передаємо також currentSong щоб клієнти знали яку пісню завантажувати
    ws.send(JSON.stringify({ type: 'sync_audio', enabled: syncCheck.checked, song: currentSong, noWords: noWordsMode }));
  }
});

// Галочка "Без слів" (акапело) — хост.
// За умовчанням завжди вимкнена (не зберігається між сесіями).
// Вимкнена  -> грає файл "<song>1.mp3" (зі словами)
// Увімкнена -> грає файл "<song>.mp3"  (акапело, без слів)
noWordsCheck?.addEventListener('change', () => {
  noWordsLabel.classList.toggle('on', noWordsCheck.checked);
  noWordsMode = noWordsCheck.checked;
  // Поточний буфер більше не відповідає режиму — скидаємо і перезавантажуємо
  // заздалегідь для обраної пісні, щоб наступний "Грати" був миттєвим.
  clearBuffer();
  if (role === 'host' && currentSong) {
    ensureBuffer(currentSong).catch(() => {});
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
    const PRE = 1.0; // seconds before timing to start glow
    for (let i = 0; i < wordSpans.length; i++) {
      const w = lyrics[i];
      if (!w) continue;
      const active    = t >= w.start && t < w.end;
      const done      = t >= w.end && !active;
      // pre-active: starts PRE seconds before word timing, ends when active begins
      const preActive = !active && !done && t >= (w.start - PRE) && t < w.start;
      wordSpans[i].classList.toggle('active',     active);
      wordSpans[i].classList.toggle('pre-active', preActive);
      wordSpans[i].classList.toggle('done',       done);
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
