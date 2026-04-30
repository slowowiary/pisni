// =============================================================================
// Karaoke – frontend  (Web Audio API для ідеальної синхронізації)
// =============================================================================

const WORKER_URL = 'https://pisni.slovo-wiry.workers.dev';

'use strict';

// ── State ────────────────────────────────────────────────────────────────────
let ws            = null;
let role          = null;
let playing       = false;
let lyrics        = [];
let animFrame     = null;
let roomId        = null;

// ── Clock sync state ─────────────────────────────────────────────────────────
// Зберігаємо кілька замірів RTT і беремо медіану для точнішого offset
let clockSamples  = [];   // [{offset, rtt}, ...]
let offset        = 0;    // serverTime – Date.now()  (ms, float)

// ── Playback state ───────────────────────────────────────────────────────────
let startTime     = null; // server ms коли почалось відтворення
let songBuffer    = null; // AudioBuffer завантаженої пісні
let sourceNode    = null; // поточний AudioBufferSourceNode
let audioCtx      = null; // Web Audio context

// ── DOM refs ─────────────────────────────────────────────────────────────────
const homeView       = document.getElementById('home-view');
const roomView       = document.getElementById('room-view');
const createBtn      = document.getElementById('create-btn');
const playBtn        = document.getElementById('play-btn');
const roomUrlEl      = document.getElementById('room-url');
const lyricsEl       = document.getElementById('lyrics');
const statusEl       = document.getElementById('status');
const syncAudioCheck = document.getElementById('sync-audio-check');

// =============================================================================
// Web Audio – ініціалізація (треба після user gesture)
// =============================================================================
function getAudioCtx() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

async function loadSongBuffer(song) {
  if (songBuffer) return songBuffer;
  setStatus('Loading audio…');
  const ctx = getAudioCtx();
  const res = await fetch(`/songs/${song}.mp3`);
  if (!res.ok) throw new Error('MP3 not found');
  const arrayBuf = await res.arrayBuffer();
  songBuffer = await ctx.decodeAudioData(arrayBuf);
  return songBuffer;
}

// =============================================================================
// Точне відтворення через Web Audio API
// Запускаємо AudioBufferSourceNode з точним contextTime
// =============================================================================
function playAudioSynced() {
  if (!songBuffer) return;
  stopAudioNode();

  const ctx     = getAudioCtx();
  const now_srv = serverNow();                          // поточний серверний час (ms)
  const elapsed = (now_srv - startTime) / 1000;         // скільки секунд пройшло

  if (elapsed >= songBuffer.duration) return;           // пісня вже закінчилась

  const src = ctx.createBufferSource();
  src.buffer = songBuffer;
  src.connect(ctx.destination);

  // ctx.currentTime — це точний таймер Web Audio (мікросекундна точність)
  // Ми хочемо почати з позиції elapsed, але враховуємо що ctx.currentTime
  // рухається незалежно від Date.now()
  const offset_sec = Math.max(0, elapsed);
  src.start(ctx.currentTime, offset_sec);  // старт зараз, з позиції offset_sec
  sourceNode = src;

  src.onended = () => { sourceNode = null; };
}

function stopAudioNode() {
  if (sourceNode) {
    try { sourceNode.stop(); } catch {}
    sourceNode = null;
  }
}

// =============================================================================
// NTP-style clock sync – багатосемплова медіана
// =============================================================================
function serverNow() {
  return Date.now() + offset;
}

function addClockSample(serverTime, clientSendTime) {
  const rtt        = Date.now() - clientSendTime;
  const sampleOffset = serverTime - (clientSendTime + rtt / 2);
  clockSamples.push({ offset: sampleOffset, rtt });
  // Тримаємо останні 8 замірів
  if (clockSamples.length > 8) clockSamples.shift();
  // Беремо зважене середнє: зразки з меншим RTT мають більшу вагу
  const minRtt = Math.min(...clockSamples.map(s => s.rtt));
  let weightSum = 0, offsetSum = 0;
  for (const s of clockSamples) {
    const w = minRtt / s.rtt;   // чим менший RTT тим більша вага
    weightSum  += w;
    offsetSum  += s.offset * w;
  }
  offset = offsetSum / weightSum;
}

async function syncTime(id) {
  // Робимо 5 замірів підряд для кращої точності
  for (let i = 0; i < 5; i++) {
    const t0  = Date.now();
    const res = await fetch(`${WORKER_URL}/room/${id}/time`);
    const { serverTime } = await res.json();
    addClockSample(serverTime, t0);
    if (i < 4) await new Promise(r => setTimeout(r, 50));
  }
}

// =============================================================================
// Persistent client identity
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
  const params = new URLSearchParams(location.search);
  const redirected = params.get('p');
  if (redirected) history.replaceState(null, '', redirected);

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
  createBtn.disabled    = true;
  createBtn.textContent = 'Creating…';
  try {
    const clientId = crypto.randomUUID();
    localStorage.setItem('karaoke_client_id', clientId);
    const res = await fetch(`${WORKER_URL}/create?clientId=${encodeURIComponent(clientId)}`);
    if (!res.ok) throw new Error(`Server responded ${res.status}`);
    const { roomId: id } = await res.json();
    history.pushState(null, '', `/room/${id}`);
    await enterRoom(id);
  } catch (err) {
    createBtn.disabled    = false;
    createBtn.textContent = 'Create Room';
    setStatus('Could not reach server: ' + err.message);
  }
});

// =============================================================================
// Enter a room
// =============================================================================
async function enterRoom(id) {
  roomId = id;
  homeView.hidden = true;
  roomView.hidden = false;
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
  const wsUrl = WORKER_URL.replace('https', 'wss').replace('http', 'ws')
              + '/room/' + id + '/ws';
  ws = new WebSocket(wsUrl);

  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'hello', clientId: getMyClientId() }));
    // Уточнюємо offset кожні 3 секунди через WS ping
    setInterval(() => {
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: 'ping', clientTime: Date.now() }));
    }, 3000);
  });

  ws.addEventListener('message', e => {
    try { onMessage(JSON.parse(e.data)); } catch {}
  });

  ws.addEventListener('close', () => {
    setStatus('Disconnected – reconnecting…');
    setTimeout(() => connectWS(id), 2000);
  });

  ws.addEventListener('error', () => setStatus('WebSocket error.'));
}

// =============================================================================
// Messages
// =============================================================================
function onMessage(msg) {
  switch (msg.type) {
    case 'joined':
      role   = msg.role;
      // Грубий початковий offset
      addClockSample(msg.serverTime, Date.now() - 50);
      if (role === 'host') {
        playBtn.hidden      = false;
        playBtn.textContent = 'Play';
        setStatus('You are the host – press Play when ready.');
        // Хост попередньо завантажує аудіо
        loadSongBuffer('test').catch(() => {});
      } else {
        setStatus('Waiting for the host to start…');
      }
      break;

    case 'pong':
      addClockSample(msg.serverTime, msg.clientTime);
      // Якщо грає — коригуємо позицію аудіо якщо потрібно
      if (playing && (role === 'host' || syncAudioCheck.checked)) {
        resyncAudio();
      }
      break;

    case 'play':
      startTime = msg.startTime;
      beginPlayback(msg.song);
      break;

    case 'stop':
      stopPlayback();
      break;

    case 'promoted':
      role                = 'host';
      playBtn.hidden      = false;
      playBtn.textContent = 'Play';
      setStatus('You are now the host.');
      loadSongBuffer('test').catch(() => {});
      break;
  }
}

// =============================================================================
// Resync – викликається після кожного pong для корекції дрейфу
// =============================================================================
function resyncAudio() {
  if (!sourceNode || !songBuffer || startTime === null) return;
  const ctx      = getAudioCtx();
  const expected = (serverNow() - startTime) / 1000;
  // Отримати поточну позицію складніше з AudioBufferSourceNode —
  // використовуємо ctx.currentTime мінус час старту ноди
  // Якщо розбіжність > 150ms — перезапускаємо з правильної позиції
  if (expected >= 0 && expected < songBuffer.duration) {
    // Порівнюємо через збережений startContextTime
    const actualPos = ctx.currentTime - sourceNode._startedAt + sourceNode._offset;
    const drift = Math.abs(actualPos - expected);
    if (drift > 0.15) {
      playAudioSynced(); // перезапуск з точної позиції
    }
  }
}

// =============================================================================
// Playback
// =============================================================================
playBtn.addEventListener('click', () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  // User gesture — розблоковуємо AudioContext
  getAudioCtx();
  ws.send(JSON.stringify({ type: playing ? 'stop' : 'play', song: 'test' }));
});

// Галочка — якщо увімкнена під час відтворення, починаємо грати зараз
syncAudioCheck.addEventListener('change', () => {
  if (syncAudioCheck.checked && playing && startTime !== null) {
    getAudioCtx();
    loadSongBuffer('test').then(() => playAudioSynced()).catch(console.error);
  } else if (!syncAudioCheck.checked) {
    stopAudioNode();
  }
});

async function beginPlayback(song) {
  playing = true;
  if (role === 'host') playBtn.textContent = 'Stop';
  setStatus('');
  startAnimation();

  const shouldPlayAudio = role === 'host' || syncAudioCheck.checked;
  if (!shouldPlayAudio) return;

  try {
    await loadSongBuffer(song);
    playAudioSynced();
  } catch (err) {
    setStatus('⚠ Audio: ' + err.message);
  }
}

function stopPlayback() {
  playing   = false;
  startTime = null;
  stopAudioNode();
  songBuffer = null; // очищаємо буфер щоб наступний play знову завантажив

  if (role === 'host') {
    playBtn.textContent = 'Play';
    setStatus('Stopped – press Play to start again.');
  } else {
    setStatus('Waiting for the host to start…');
  }
  stopAnimation();
  clearHighlights();
}

// =============================================================================
// Перевизначаємо playAudioSynced щоб зберігати метадані для resync
// =============================================================================
const _origPlayAudioSynced = playAudioSynced;
// Патчимо щоб зберігати _startedAt та _offset
function playAudioSynced() {
  if (!songBuffer) return;
  stopAudioNode();
  const ctx     = getAudioCtx();
  const elapsed = Math.max(0, (serverNow() - startTime) / 1000);
  if (elapsed >= songBuffer.duration) return;

  const src = ctx.createBufferSource();
  src.buffer  = songBuffer;
  src.connect(ctx.destination);
  src._startedAt = ctx.currentTime;  // коли стартували в AudioContext часі
  src._offset    = elapsed;           // з якої позиції
  src.start(ctx.currentTime, elapsed);
  sourceNode = src;
  src.onended = () => { if (sourceNode === src) sourceNode = null; };
}

// =============================================================================
// Lyrics
// =============================================================================
async function loadLyrics(song) {
  try {
    const res = await fetch(`/songs/${song}.json`);
    if (!res.ok) throw new Error(res.status);
    lyrics = await res.json();
    renderWords();
  } catch (err) {
    lyricsEl.textContent = '⚠ Could not load lyrics: ' + err.message;
  }
}

function renderWords() {
  lyricsEl.innerHTML = '';
  lyrics.forEach((entry, i) => {
    const span = document.createElement('span');
    span.textContent = entry.word;
    span.className   = 'word';
    span.dataset.i   = i;
    lyricsEl.appendChild(span);
    lyricsEl.appendChild(document.createTextNode(' '));
  });
}

// =============================================================================
// Animation
// =============================================================================
function startAnimation() {
  stopAnimation();
  function tick() {
    if (!playing || startTime === null) return;
    highlight((serverNow() - startTime) / 1000);
    animFrame = requestAnimationFrame(tick);
  }
  animFrame = requestAnimationFrame(tick);
}

function stopAnimation() {
  if (animFrame !== null) { cancelAnimationFrame(animFrame); animFrame = null; }
}

function highlight(elapsed) {
  document.querySelectorAll('.word').forEach((span, i) => {
    const w = lyrics[i];
    span.classList.toggle('active', elapsed >= w.start && elapsed < w.end);
    span.classList.toggle('done',   elapsed >= w.end);
  });
}

function clearHighlights() {
  document.querySelectorAll('.word').forEach(s => s.classList.remove('active', 'done'));
}

function setStatus(msg) { statusEl.textContent = msg; }

document.addEventListener('click', e => {
  if (e.target.id !== 'room-url') return;
  navigator.clipboard.writeText(e.target.textContent).then(() => {
    const orig = e.target.textContent;
    e.target.textContent = 'Copied!';
    setTimeout(() => { e.target.textContent = orig; }, 1500);
  });
});

init();
