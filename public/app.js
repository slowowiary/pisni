// =============================================================================
// Karaoke – frontend v5
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
let audioBuffer    = null;
let loadingSong    = null;
let audioUnlocked  = false;
let isMuted        = false;

// ── Синхронізація годинника ───────────────────────────────────────────────────
// offset (мс): serverTime ≈ Date.now() + offset
// Алгоритм NTP-like: беремо кілька замірів, відкидаємо з великим RTT,
// усереднюємо зважено (вага = 1/RTT).
let clockSamples   = [];   // { off, rtt }[]
let offset         = 0;    // поточний offset (мс)

// ── Адаптивна корекція playbackRate ──────────────────────────────────────────
// Основний механізм синку — плавна зміна швидкості, НЕ seek.
// Seek тільки при великому рассинхроні (> 120 мс).
const SYNC_CORRECTION_WINDOW = 3.0;   // с — вікно для розрахунку rate
const SYNC_MAX_RATE_DELTA    = 0.02;  // ±2% від нормальної швидкості
const SYNC_RATE_LERP         = 0.12;  // коеф. плавного наближення за крок
const SYNC_MIN_RATE_CHANGE   = 0.001; // не змінювати якщо різниця менша
let   currentPlaybackRate    = 1.0;
let   rateRampTimer          = null;

// ── Лічильник HTTP-запитів ────────────────────────────────────────────────────
const httpCount = { session: 0, total: 0 };
function countHTTP() { httpCount.session++; httpCount.total++; dbUpdate(); }

// ── Debug-панель ─────────────────────────────────────────────────────────────
let dbEl       = null;
let dbError    = null;   // остання помилка синку (с)
let dbRTT      = null;   // останній RTT (мс)
let dbRate     = 1.0;    // поточний playbackRate
let dbSrc      = '—';    // 'ws' / 'http'
let dbInterval = '—';    // поточний інтервал синку

function dbInit() {
  dbEl = document.createElement('div');
  dbEl.style.cssText = [
    'position:fixed','bottom:4px','left:0','right:0',
    'text-align:center','font-size:10px','color:#777',
    'pointer-events:none','z-index:9999','font-family:monospace',
    'line-height:1.8','padding:0 8px','letter-spacing:0.03em',
  ].join(';');
  document.body.appendChild(dbEl);
  dbUpdate();
}

function dbUpdate() {
  if (!dbEl) return;
  const errStr  = dbError !== null
    ? (dbError >= 0 ? '+' : '') + (dbError * 1000).toFixed(1) + ' ms'
    : '— ms';
  const rttStr  = dbRTT  !== null ? dbRTT.toFixed(0) + ' ms' : '—';
  const offStr  = (offset >= 0 ? '+' : '') + offset.toFixed(1) + ' ms';
  dbEl.textContent =
    `err: ${errStr}  |  RTT: ${rttStr}  |  rate: ${dbRate.toFixed(4)}  |  clk: ${offStr}  |  via: ${dbSrc}  |  Δt: ${dbInterval}  |  HTTP/session: ${httpCount.session}`;
}

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

// UI
let lyrics         = [];
let animFrame      = null;
let scrollFrame    = null;
let currentScrollY = 0;
let targetScrollY  = 0;
let songs          = [];
let wakeLock       = null;
let syncAudioEnabled = false;

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
  } catch (e) {
    loadingSong = null; audioBuffer = null;
    throw e;
  }
}

function clearBuffer() { audioBuffer = null; loadingSong = null; }

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

  const when = Math.max(
    audioCtx.currentTime + 0.005,
    audioCtx.currentTime + msUntil / 1000
  );
  const src = audioCtx.createBufferSource();
  src.buffer   = audioBuffer;
  src._when    = when;   // audioCtx час запуску (для getActualPos)
  src._off     = off;    // зсув у буфері
  gainNode.gain.value = isMuted ? 0 : 1;
  src.connect(gainNode);
  src.start(when, off);
  sourceNode = src;
  currentPlaybackRate = 1.0; // скидаємо після кожного (пере)старту

  src.onended = () => {
    if (sourceNode === src) {
      sourceNode = null;
      if (role === 'host' && playing) songEnded();
    }
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
  playBtn.hidden = false; playBtn.textContent = '▶ Грати';
  pauseBtn.hidden = true;
  setStatus('Пісня закінчилась. Виберіть наступну.');
  stopAnim(); clearHL(); highlightSong(currentSong, false);
}

// =============================================================================
// Синхронізація годинника
// =============================================================================
function serverNow() { return Date.now() + offset; }

// Додає замір і перераховує offset.
// NTP-like алгоритм: беремо 70% замірів з найменшим RTT, усереднюємо зважено.
function addSample(srvTime, t0, src) {
  const rtt    = Date.now() - t0;
  const sample = { off: srvTime - (t0 + rtt / 2), rtt };
  clockSamples.push(sample);
  if (clockSamples.length > 16) clockSamples.shift();

  const sorted = [...clockSamples].sort((a, b) => a.rtt - b.rtt);
  const use    = sorted.slice(0, Math.max(2, Math.floor(sorted.length * 0.7)));
  const minRtt = use[0].rtt;

  let wsum = 0, osum = 0;
  for (const s of use) {
    const w = minRtt / s.rtt;
    wsum += w; osum += s.off * w;
  }
  offset = osum / wsum;

  dbRTT = rtt;
  dbSrc = src || '?';
  dbUpdate();
}

// ── WS ping/pong — основний спосіб синхронізації (0 HTTP!) ───────────────────
// Надсилає ping по відкритому WS і чекає pong із serverTime.
// Одноразовий listener — не конфліктує з основним handleMsg.
function wsPing() {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      reject(new Error('ws not open')); return;
    }
    const t0  = Date.now();
    const tid = setTimeout(() => {
      ws.removeEventListener('message', onMsg);
      reject(new Error('pong timeout'));
    }, 4000);

    function onMsg(e) {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.type !== 'pong') return;
      ws.removeEventListener('message', onMsg);
      clearTimeout(tid);
      addSample(m.serverTime, t0, 'ws');
      resolve(Date.now() - t0);
    }
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ type: 'ping', clientTime: t0 }));
  });
}

// HTTP-замір — тільки при вході або якщо WS ще не відкритий
async function httpPing(id) {
  const t0  = Date.now();
  const res = await fetch(`${WORKER_URL}/room/${id}/time`).catch(() => null);
  countHTTP();
  if (res?.ok) addSample((await res.json()).serverTime, t0, 'http');
}

// Початкова синхронізація при вході: 4 HTTP заміри (WS ще не відкритий)
async function syncOnEntry(id) {
  for (let i = 0; i < 4; i++) {
    await httpPing(id);
    if (i < 3) await new Promise(r => setTimeout(r, 40));
  }
}

// count WS-замірів. При помилці WS — HTTP fallback.
async function resync(count = 3) {
  for (let i = 0; i < count; i++) {
    try {
      await wsPing();
    } catch {
      if (roomId) await httpPing(roomId);
    }
    if (i < count - 1) await new Promise(r => setTimeout(r, 50));
  }
}

// =============================================================================
// Поточна позиція аудіо
// =============================================================================
// ВАЖЛИВО: використовуємо audioCtx.currentTime — стабільний монотонний лічильник,
// не залежить від jitter JS. НЕ використовуємо Date.now() для позиції.
function getActualPos() {
  if (!sourceNode || !audioCtx) return null;
  return sourceNode._off + (audioCtx.currentTime - sourceNode._when);
}

// =============================================================================
// Корекція playbackRate
// =============================================================================
function applyPlaybackRate(targetRate) {
  if (!sourceNode?.playbackRate || !audioCtx) return;
  const clamped = Math.max(
    1 - SYNC_MAX_RATE_DELTA,
    Math.min(1 + SYNC_MAX_RATE_DELTA, targetRate)
  );
  const diff = clamped - currentPlaybackRate;
  if (Math.abs(diff) < SYNC_MIN_RATE_CHANGE) return;
  currentPlaybackRate += diff * SYNC_RATE_LERP;
  // linearRampToValueAtTime — плавно, без клацань в аудіо
  sourceNode.playbackRate.linearRampToValueAtTime(
    currentPlaybackRate,
    audioCtx.currentTime + 0.25
  );
  dbRate = currentPlaybackRate;
  dbUpdate();
}

function resetPlaybackRate() {
  currentPlaybackRate = 1.0;
  if (sourceNode?.playbackRate)
    sourceNode.playbackRate.setValueAtTime(1.0, audioCtx?.currentTime || 0);
  if (rateRampTimer) { clearInterval(rateRampTimer); rateRampTimer = null; }
  dbRate = 1.0;
  dbUpdate();
}

// Плавний цикл наближення до targetRate (~12 fps, до 25 кроків)
function startRateRamp(targetRate) {
  if (rateRampTimer) { clearInterval(rateRampTimer); rateRampTimer = null; }
  let steps = 0;
  rateRampTimer = setInterval(() => {
    if (!sourceNode || !playing || paused) {
      clearInterval(rateRampTimer); rateRampTimer = null; return;
    }
    applyPlaybackRate(targetRate);
    if (++steps > 25 || Math.abs(currentPlaybackRate - targetRate) < SYNC_MIN_RATE_CHANGE) {
      clearInterval(rateRampTimer); rateRampTimer = null;
    }
  }, 80);
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

// =============================================================================
// checkAndCorrect — серце синхронізації
// =============================================================================
// 1. WS ping → оновлює offset (0 HTTP)
// 2. Рахує error = targetPos - actualPos
// 3. Стратегія залежно від розміру error
async function checkAndCorrect() {
  if (!playing || paused || startTime === null) return;

  try { await wsPing(); }
  catch { return; } // WS впав — пропускаємо

  const targetPos = (serverNow() - startTime) / 1000;
  const actualPos = getActualPos();

  if (actualPos === null) { scheduleAudio(); return; }

  const error    = targetPos - actualPos;  // + = відстаємо, − = поспішаємо
  const absError = Math.abs(error);

  dbError = error;
  dbUpdate();

  // (A) > 120 мс — жорсткий seek + плавна доводка
  if (absError > 0.120) {
    console.log(`[sync] SEEK  err=${(error*1000).toFixed(0)}ms`);
    scheduleAudio();
    startRateRamp(1 + clamp(error / SYNC_CORRECTION_WINDOW, -SYNC_MAX_RATE_DELTA, SYNC_MAX_RATE_DELTA));
    return;
  }

  // (B) 20–120 мс — тільки playbackRate
  if (absError > 0.020) {
    const rate = 1 + clamp(error / SYNC_CORRECTION_WINDOW, -SYNC_MAX_RATE_DELTA, SYNC_MAX_RATE_DELTA);
    console.log(`[sync] RATE  err=${(error*1000).toFixed(1)}ms rate=${rate.toFixed(4)}`);
    startRateRamp(rate);
    return;
  }

  // (C) 5–20 мс — м'яка корекція
  if (absError > 0.005) {
    applyPlaybackRate(1 + clamp(error / SYNC_CORRECTION_WINDOW, -SYNC_MAX_RATE_DELTA, SYNC_MAX_RATE_DELTA));
    return;
  }

  // (D) < 5 мс — ідеально, плавно повертаємо до 1.0
  applyPlaybackRate(1.0);
}

// =============================================================================
// Адаптивний таймер синхронізації
// =============================================================================
let correctionTimers    = [];
let periodicSyncTimeout = null;
let syncConsecutiveOk   = 0;
let syncIntervalMs      = 2000;

function schedulePostStartCorrections() {
  correctionTimers.forEach(t => clearTimeout(t));
  correctionTimers = [];
  syncConsecutiveOk = 0;
  syncIntervalMs    = 1000;

  // Перша перевірка через 2.5 с після старту
  correctionTimers.push(setTimeout(() => checkAndCorrect(), 2500));
  startPeriodicSync();
}

function startPeriodicSync() {
  stopPeriodicSync();

  async function tick() {
    if (!playing || paused) { scheduleNext(5000); return; }

    await checkAndCorrect();

    const absErr = dbError !== null ? Math.abs(dbError) : 0.1;
    if (absErr < 0.005) {
      syncConsecutiveOk++;
      if (syncConsecutiveOk >= 10)     syncIntervalMs = Math.min(syncIntervalMs * 1.6, 40000);
      else if (syncConsecutiveOk >= 5) syncIntervalMs = Math.min(syncIntervalMs * 1.3, 15000);
      else                             syncIntervalMs = Math.min(syncIntervalMs * 1.1, 8000);
    } else {
      syncConsecutiveOk = 0;
      if (absErr > 0.050)      syncIntervalMs = 1000;
      else if (absErr > 0.020) syncIntervalMs = 2000;
      else                     syncIntervalMs = 4000;
    }

    dbInterval = syncIntervalMs >= 1000
      ? (syncIntervalMs / 1000).toFixed(1) + 's'
      : syncIntervalMs + 'ms';
    dbUpdate();
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
  if (!('wakeLock' in navigator)) return;
  if (wakeLock && !wakeLock.released) return;
  try { wakeLock = await navigator.wakeLock.request('screen'); } catch {}
}
function releaseWakeLock() {
  if (role === 'host') return; // хост тримає постійно
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
    countHTTP();
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
      resync(3).then(() => { scheduleAudio(); schedulePostStartCorrections(); });
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
  dbInit();
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
    unlockAudio();
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
    countHTTP();
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
  await syncOnEntry(id);   // 4 HTTP поки WS не відкритий
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
    // Keepalive ping кожні 20 с (оновлює offset безкоштовно)
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
// Обробка повідомлень WebSocket
// =============================================================================
async function handleMsg(msg) {
  switch (msg.type) {

    case 'joined': {
      role = msg.role;
      // Безкоштовний початковий замір із joined-повідомлення
      addSample(msg.serverTime, Date.now() - 30, 'ws-join');

      if (role === 'host') {
        joinScreen.hidden = true;
        buildSongList();
        songPicker.hidden = false;
        playBtn.hidden = true; pauseBtn.hidden = true;
        syncLabel.hidden = false; setHeaderToggle(false);
        lyricsCont.hidden = true;
        const saved = localStorage.getItem('karaoke_sync_audio') === '1';
        syncCheck.checked = saved;
        syncLabel.classList.toggle('on', saved);
        syncAudioEnabled = saved;
        if (saved) ws.send(JSON.stringify({ type: 'sync_audio', enabled: true }));
        setStatus('Виберіть пісню зі списку нижче.');
        requestWakeLock(); // хост тримає екран завжди
      } else {
        songPicker.hidden = true; playBtn.hidden = true;
        pauseBtn.hidden = true; syncLabel.hidden = true;
        lyricsCont.hidden = true;
        syncAudioEnabled = msg.syncAudio || false;
        setHeaderToggle(syncAudioEnabled);
        setStatus('Очікування хоста…');
      }
      break;
    }

    // pong обробляється всередині wsPing() — тут пропускаємо
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

      httpCount.session = 0; // скидаємо лічильник для нової пісні
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
      startAnim(); startScroll(); requestWakeLock();
      setStatus('');
      if (role === 'host') { pauseBtn.textContent = '⏸ Пауза'; }
      if (role === 'host' || (syncAudioEnabled && audioUnlocked && audioBuffer && !isMuted)) {
        await resync(4); // 4 WS ping після паузи
        scheduleAudio();
        schedulePostStartCorrections();
      }
      break;
    }

    case 'stop': {
      playing = false; paused = false; startTime = null;
      cancelCorrections(); stopNode();
      if (gainNode) gainNode.gain.setValueAtTime(0, audioCtx?.currentTime || 0);
      releaseWakeLock();
      stopAnim(); stopScroll(); clearHL(); resetScroll();
      setTimeout(() => {
        if (gainNode) gainNode.gain.setValueAtTime(isMuted ? 0 : 1, audioCtx?.currentTime || 0);
      }, 100);
      if (role === 'host') {
        playBtn.hidden = false; playBtn.textContent = '▶ Грати'; pauseBtn.hidden = true;
        highlightSong(currentSong, false);
        setStatus('Зупинено. Виберіть пісню та натисніть «Грати».');
      } else {
        setStatus('Очікування хоста…');
      }
      break;
    }

    case 'sync_audio': {
      syncAudioEnabled = msg.enabled;
      if (role === 'host') break;

      if (msg.enabled) {
        setHeaderToggle(true);
        if (msg.song && msg.song !== currentSong) {
          currentSong = msg.song;
          clearBuffer();
          await loadLyrics(msg.song);
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
            await resync(3);
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
      setHeaderToggle(false);
      setStatus('Ви тепер хост.');
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
      playing = false;
      playBtn.hidden = false; playBtn.textContent = '▶ Грати'; playBtn.disabled = false;
      pauseBtn.hidden = true;
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
    await resync(3);       // 3 WS ping (є 3 с запасу до старту)
    scheduleAudio();
    schedulePostStartCorrections();

  } else if (syncAudioEnabled && audioUnlocked && !isMuted) {
    if (!audioBuffer || currentSong !== song) {
      stopNode(); clearBuffer();
      setStatus('⏳ Завантаження…');
      try {
        await Promise.all([ensureBuffer(song), resync(3)]);
        setStatus('');
      } catch (e) {
        stopNode(); clearBuffer();
        setStatus('⚠ ' + e.message);
        return;
      }
    }
    await resync(3);       // ще 3 WS ping після завантаження
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
    catch (e) {
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

function cacheSpans() {
  wordSpans = Array.from(lyricsEl?.querySelectorAll('.word') || []);
}

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
