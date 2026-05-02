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
  // No SAFETY_OFFSET in file position — adding it to 'off' causes getActualPos()
  // to return (elapsed + SAFETY_OFFSET) which is always ~30ms above expected,
  // creating a permanent fake drift that triggers endless restarts.
  // Web Audio src.start(when, off) with 'when' in the future provides its own buffer.
  const off = Math.min(elapsed, audioBuffer.duration - 0.01);
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

  if (clockSamples.length <= 1) {
    // First sample after reset — trust fully (no previous value to compare)
    const prevOff = offset;
    offset = newOffset;
    if (DEBUG_SYNC) _dbg.event('offset', `${prevOff.toFixed(1)}→${offset.toFixed(1)}ms (first)`);
  } else {
    const prevOff = offset;
    // EMA 80/20 with 40ms/step clamp
    const blended = offset * 0.8 + newOffset * 0.2;
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
  for (let i = 0; i < 4; i++) {
    const t0  = Date.now();
    const res = await fetch(`${WORKER_URL}/room/${roomId}/time`).catch(() => null);
    if (res?.ok) {
      addSample((await res.json()).serverTime, t0);
      requestState.lastRequestTime = Date.now();
    }
    if (i < 3) await new Promise(r => setTimeout(r, 30));
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
  largeDriftCount:    0,     // скільки разів поспіль drift > 40ms
  pendingRestart:     false, // перший великий drift → чекаємо підтвердження
  stableCount:        0,     // скільки разів поспіль drift < 15ms (інерція)
  lastOffset:         null,  // попередній offset після запиту — для виявлення стрибків
  lastSmdSign:        0,     // sign of smoothedDrift last cycle — oscillation guard
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
  const isNoisy    = (offsetJump > 20 && syncState.driftHistory.length > 0);
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
    const _needsAct = absSmoothed >= 15 || Math.abs(drift) > 40;
    const _decision = !_needsAct ? 'idle'
      : (syncState.pendingRestart ? 'restart(pending)' : 'restart(first)');
    _dbg.log(`${((Date.now()-_DBG_START)/1000).toFixed(1)}s [cycle] req | off=${offset.toFixed(1)} exp=${expected.toFixed(3)} act=${actualNow.toFixed(3)} drift=${drift.toFixed(1)} smd=${smoothedDrift.toFixed(1)} dRate=${driftRate.toFixed(2)} rate=${syncState.smoothedRate.toFixed(4)} dec=${_decision} stab=${requestState.stabilityScore} urg=${urgencyState.level|0}`);
    _dbg.scheduleUiUpdate();
  }

  // Also trigger restart if raw drift is already large even if smd hasn't caught up.
  // smd with 8-sample buffer lags 40-80s; raw drift > 40ms is immediately audible.
  const needsAction = absSmoothed >= 15 || Math.abs(drift) > 40;

  if (!needsAction) {
    // Dead zone — drift inaudible, slowly return rate to 1.0
    syncState.largeDriftCount = 0;
    syncState.pendingRestart  = false;
    syncState.lastSmdSign     = 0;
    syncState.stableCount     = Math.min(syncState.stableCount + 1, 20);
    syncState.smoothedRate    = syncState.smoothedRate + (1.0 - syncState.smoothedRate) * 0.05;
    applyPlaybackRate(syncState.smoothedRate);

  } else {
    // Audible drift (≥15ms) — restart immediately to correct position,
    // then set playbackRate to compensate systematic drift going forward.
    // Rate-only correction (old middle zone) took 4+ minutes to close 27ms — too slow.
    // Restart is inaudible when position is accurate; cooldown prevents restart loops.
    syncState.stableCount = 0;
    syncState.lastSmdSign = 0;

    const now        = Date.now();
    const canRestart = (now - syncState.lastRestartTime) > 3000;

    // In first 15s of playback, skip confirmation — initial offset error
    // needs immediate correction. After 15s, require 2 consecutive measurements.
    const playingForMs     = startTime !== null ? (serverNow() - startTime) : 99999;
    const skipConfirmation = playingForMs < 15000;

    if (!syncState.pendingRestart && !skipConfirmation) {
      // Normal mode: set flag, verify next cycle
      syncState.pendingRestart  = true;
      syncState.largeDriftCount = 1;
      syncState.smoothedRate    = syncState.smoothedRate + (1.0 - syncState.smoothedRate) * 0.05;
      applyPlaybackRate(syncState.smoothedRate);

    } else if (canRestart && (skipConfirmation || syncState.pendingRestart)) {
      // Confirmed by two consecutive cycles — restart now
      syncState.lastRestartTime = now;
      syncState.skipNext        = true;
      syncState.largeDriftCount = 0;
      syncState.pendingRestart  = false;
      urgencyState.level          = Math.min(100, urgencyState.level + 20);
      requestState.stabilityScore = Math.max(0, requestState.stabilityScore - 10);
      if (DEBUG_SYNC) _dbg.event('RESTART', `smd=${smoothedDrift.toFixed(1)}ms drift=${drift.toFixed(1)}ms offset=${offset.toFixed(1)}ms`);
      // Fresh offset before restart — stale offset causes landing 50-100ms off
      await preSync();
      scheduleAudio();
      // Reset rate to 1.0 after restart — pre-restart smoothedDrift is stale
      // and calcTargetRate would push in the wrong direction.
      // Next cycles will measure real post-restart drift and correct if needed.
      syncState.smoothedRate = 1.0;
      applyPlaybackRate(1.0);

    } else {
      // Cooldown active — wait, nudge slowly toward 1.0
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
        if (saved) ws.send(JSON.stringify({ type: 'sync_audio', enabled: true }));
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
        lyricsCont.hidden = true;
        syncAudioEnabled = msg.syncAudio || false;
        setHeaderToggle(syncAudioEnabled);
        setStatus('Очікування хоста…');
      }
      break;
    }

    case 'pong':
      break;

    // ── Debug log from client ─────────────────────────────────────────────────
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
    await preSync();
    scheduleAudio();
    startAdaptiveSyncLoop();

  } else if (syncAudioEnabled && audioUnlocked && !isMuted) {
    if (!audioBuffer || currentSong !== song) {
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
    const PRE = 0.5; // seconds before timing to start glow
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
