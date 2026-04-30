// =============================================================================
// Karaoke – frontend  (ідеальна синхронізація через scheduled Web Audio start)
// =============================================================================

const WORKER_URL = 'https://pisni.slovo-wiry.workers.dev';
'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
let ws         = null;
let role       = null;
let playing    = false;
let lyrics     = [];
let animFrame  = null;
let roomId     = null;
let startTime  = null;   // серверний ms коли почалось відтворення
let songBuffer = null;   // AudioBuffer
let sourceNode = null;   // поточний AudioBufferSourceNode
let audioCtx   = null;

// ── Clock sync ────────────────────────────────────────────────────────────────
let clockSamples = [];
let offset       = 0;   // serverTime − Date.now(), ms (float)

// ── DOM ───────────────────────────────────────────────────────────────────────
const homeView       = document.getElementById('home-view');
const roomView       = document.getElementById('room-view');
const createBtn      = document.getElementById('create-btn');
const playBtn        = document.getElementById('play-btn');
const roomUrlEl      = document.getElementById('room-url');
const lyricsEl       = document.getElementById('lyrics');
const statusEl       = document.getElementById('status');
const syncAudioCheck = document.getElementById('sync-audio-check');

// =============================================================================
// AudioContext
// =============================================================================
function getCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

async function loadSongBuffer(song) {
  if (songBuffer) return songBuffer;
  const res = await fetch('/songs/' + song + '.mp3');
  if (!res.ok) throw new Error('MP3 404');
  const buf = await res.arrayBuffer();
  songBuffer = await getCtx().decodeAudioData(buf);
  return songBuffer;
}

// =============================================================================
// Scheduled playback — ключова ідея:
//
//  serverStart  = серверний мілісекунд коли треба починати (startTime)
//  ctxStart     = AudioContext.currentTime в той момент
//
//  Формула:
//    serverStart_in_ctx = ctx.currentTime + (serverStart − serverNow()) / 1000
//
//  Якщо serverStart вже в минулому — починаємо з offset в пісні.
// =============================================================================
function scheduleAudio() {
  if (!songBuffer || startTime === null) return;
  stopAudioNode();

  const ctx = getCtx();

  // Скільки секунд від зараз до моменту старту (може бути від'ємним)
  const msUntilStart  = startTime - serverNow();
  const secUntilStart = msUntilStart / 1000;

  let ctxWhen;    // коли запустити в AudioContext часі
  let songOffset; // з якої позиції в пісні

  if (secUntilStart > 0) {
    // Старт ще попереду — плануємо точно
    ctxWhen    = ctx.currentTime + secUntilStart;
    songOffset = 0;
  } else {
    // Старт вже пройшов — запускаємо зараз з правильної позиції
    ctxWhen    = ctx.currentTime + 0.01; // мінімальна затримка для планування
    songOffset = Math.min(-secUntilStart, songBuffer.duration - 0.1);
  }

  if (songOffset >= songBuffer.duration) return; // пісня вже закінчилась

  const src    = ctx.createBufferSource();
  src.buffer   = songBuffer;
  src.connect(ctx.destination);

  // Зберігаємо для resync
  src._ctxWhen    = ctxWhen;
  src._songOffset = songOffset;

  src.start(ctxWhen, songOffset);
  sourceNode = src;
  src.onended = () => { if (sourceNode === src) sourceNode = null; };
}

function stopAudioNode() {
  if (sourceNode) {
    try { sourceNode.stop(); } catch {}
    sourceNode = null;
  }
}

// Поточна позиція в пісні (для перевірки дрейфу)
function currentSongPos() {
  if (!sourceNode || !audioCtx) return null;
  const elapsed = audioCtx.currentTime - sourceNode._ctxWhen;
  return sourceNode._songOffset + elapsed;
}

// Resync — перевіряємо дрейф після кожного pong
function resyncIfNeeded() {
  if (!playing || startTime === null || !songBuffer) return;
  if (role !== 'host' && !syncAudioCheck.checked) return;

  const expected = (serverNow() - startTime) / 1000;
  const actual   = currentSongPos();
  if (actual === null) return;

  const drift = Math.abs(actual - expected);
  if (drift > 0.05) { // 50ms — перезапускаємо
    scheduleAudio();
  }
}

// =============================================================================
// NTP clock sync — зважена медіана по RTT
// =============================================================================
function serverNow() { return Date.now() + offset; }

function addClockSample(serverTime, t0) {
  const rtt    = Date.now() - t0;
  const sample = { offset: serverTime - (t0 + rtt / 2), rtt };
  clockSamples.push(sample);
  if (clockSamples.length > 10) clockSamples.shift();

  // Відкидаємо верхні 25% по RTT (викиди)
  const sorted  = [...clockSamples].sort((a, b) => a.rtt - b.rtt);
  const trimmed = sorted.slice(0, Math.max(1, Math.floor(sorted.length * 0.75)));

  const minRtt = trimmed[0].rtt;
  let wSum = 0, oSum = 0;
  for (const s of trimmed) {
    const w = minRtt / s.rtt;
    wSum += w; oSum += s.offset * w;
  }
  offset = oSum / wSum;
}

async function syncTime(id) {
  // 8 замірів з паузою 30ms між ними
  for (let i = 0; i < 8; i++) {
    const t0  = Date.now();
    const res = await fetch(`${WORKER_URL}/room/${id}/time`);
    const { serverTime } = await res.json();
    addClockSample(serverTime, t0);
    if (i < 7) await new Promise(r => setTimeout(r, 30));
  }
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
// Boot
// =============================================================================
async function init() {
  const p = new URLSearchParams(location.search).get('p');
  if (p) history.replaceState(null, '', p);
  const id = parseRoomFromPath();
  if (id) { await enterRoom(id); } else { homeView.hidden = false; }
}

function parseRoomFromPath() {
  const m = location.pathname.match(/\/room\/([a-z0-9]+)/i);
  return m ? m[1] : null;
}

// =============================================================================
// Create room
// =============================================================================
createBtn.addEventListener('click', async () => {
  createBtn.disabled = true; createBtn.textContent = 'Creating…';
  try {
    const clientId = crypto.randomUUID();
    localStorage.setItem('karaoke_client_id', clientId);
    const res = await fetch(`${WORKER_URL}/create?clientId=${encodeURIComponent(clientId)}`);
    if (!res.ok) throw new Error(res.status);
    const { roomId: id } = await res.json();
    history.pushState(null, '', '/room/' + id);
    await enterRoom(id);
  } catch (err) {
    createBtn.disabled = false; createBtn.textContent = 'Create Room';
    setStatus('Error: ' + err.message);
  }
});

// =============================================================================
// Enter room
// =============================================================================
async function enterRoom(id) {
  roomId = id;
  homeView.hidden = true; roomView.hidden = false;
  roomUrlEl.textContent = location.href;
  setStatus('Syncing clock…');
  await syncTime(id);
  setStatus('Loading lyrics…');
  await loadLyrics('test');
  setStatus('Connecting…');
  connectWS(id);
}

// =============================================================================
// WebSocket
// =============================================================================
function connectWS(id) {
  const url = WORKER_URL.replace('https','wss').replace('http','ws') + '/room/' + id + '/ws';
  ws = new WebSocket(url);

  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'hello', clientId: getMyClientId() }));
    // Ping кожні 2 секунди для постійного уточнення offset
    setInterval(() => {
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: 'ping', clientTime: Date.now() }));
    }, 2000);
  });

  ws.addEventListener('message', e => { try { onMessage(JSON.parse(e.data)); } catch {} });
  ws.addEventListener('close',   () => { setStatus('Reconnecting…'); setTimeout(() => connectWS(id), 2000); });
  ws.addEventListener('error',   () => setStatus('WebSocket error.'));
}

// =============================================================================
// Messages
// =============================================================================
function onMessage(msg) {
  switch (msg.type) {
    case 'joined':
      role = msg.role;
      addClockSample(msg.serverTime, Date.now() - 50);
      if (role === 'host') {
        playBtn.hidden = false; playBtn.textContent = 'Play';
        setStatus('You are the host – press Play when ready.');
        loadSongBuffer('test').catch(() => {});
      } else {
        setStatus('Waiting for the host to start…');
      }
      break;

    case 'pong':
      addClockSample(msg.serverTime, msg.clientTime);
      resyncIfNeeded();
      break;

    case 'play':
      startTime = msg.startTime;
      onPlay(msg.song);
      break;

    case 'stop':
      onStop();
      break;

    case 'promoted':
      role = 'host';
      playBtn.hidden = false; playBtn.textContent = 'Play';
      setStatus('You are now the host.');
      loadSongBuffer('test').catch(() => {});
      break;
  }
}

// =============================================================================
// Play / Stop
// =============================================================================
playBtn.addEventListener('click', () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  getCtx(); // розблокувати AudioContext при user gesture
  ws.send(JSON.stringify({ type: playing ? 'stop' : 'play', song: 'test' }));
});

syncAudioCheck.addEventListener('change', () => {
  getCtx();
  if (syncAudioCheck.checked && playing && startTime !== null) {
    loadSongBuffer('test').then(scheduleAudio).catch(console.error);
  } else if (!syncAudioCheck.checked) {
    stopAudioNode();
  }
});

async function onPlay(song) {
  playing = true;
  if (role === 'host') playBtn.textContent = 'Stop';
  setStatus('');
  startAnimation();

  if (role !== 'host' && !syncAudioCheck.checked) return;
  getCtx();
  try {
    await loadSongBuffer(song);
    scheduleAudio();
  } catch (err) {
    setStatus('⚠ Audio: ' + err.message);
  }
}

function onStop() {
  playing = false; startTime = null;
  stopAudioNode();
  songBuffer = null;
  if (role === 'host') { playBtn.textContent = 'Play'; setStatus('Stopped.'); }
  else setStatus('Waiting for the host to start…');
  stopAnimation(); clearHighlights();
}

// =============================================================================
// Lyrics
// =============================================================================
async function loadLyrics(song) {
  try {
    const res = await fetch('/songs/' + song + '.json');
    if (!res.ok) throw new Error(res.status);
    lyrics = await res.json(); renderWords();
  } catch (err) { lyricsEl.textContent = '⚠ ' + err.message; }
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
    if (!playing || startTime === null) return;
    highlight((serverNow() - startTime) / 1000);
    animFrame = requestAnimationFrame(tick);
  })();
}
function stopAnimation() { if (animFrame) { cancelAnimationFrame(animFrame); animFrame = null; } }
function highlight(t) {
  document.querySelectorAll('.word').forEach((s, i) => {
    const w = lyrics[i];
    s.classList.toggle('active', t >= w.start && t < w.end);
    s.classList.toggle('done',   t >= w.end);
  });
}
function clearHighlights() { document.querySelectorAll('.word').forEach(s => s.classList.remove('active','done')); }
function setStatus(m) { statusEl.textContent = m; }

document.addEventListener('click', e => {
  if (e.target.id !== 'room-url') return;
  navigator.clipboard.writeText(e.target.textContent).then(() => {
    const o = e.target.textContent; e.target.textContent = 'Copied!';
    setTimeout(() => { e.target.textContent = o; }, 1500);
  });
});

init();
