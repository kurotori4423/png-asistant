'use strict';

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Eye / blink state
// ---------------------------------------------------------------------------
const eyeLayers = {
  normal: document.getElementById('eye-normal'),
  closed: document.getElementById('eye-closed'),
  half:   document.getElementById('eye-half'),
};

function setEyeState(state) {
  for (const [key, el] of Object.entries(eyeLayers)) {
    el.style.display = key === state ? 'block' : 'none';
  }
}

async function blink() {
  const frames = ['normal', 'half', 'closed', 'half', 'normal'];
  const delays = [50, 80, 80, 50];

  for (let i = 0; i < frames.length; i++) {
    setEyeState(frames[i]);
    if (i < delays.length) await sleep(delays[i]);
  }

  setTimeout(blink, 3000 + Math.random() * 4000);
}

// ---------------------------------------------------------------------------
// Expression (smile overlay)
// ---------------------------------------------------------------------------
const smileEl = document.getElementById('smile');

function setExpression(value) {
  smileEl.style.display = value === 'smile' ? 'block' : 'none';
}

// ---------------------------------------------------------------------------
// Mouth / lip sync
// ---------------------------------------------------------------------------
const mouthEl = document.getElementById('mouth');
const VOLUME_THRESHOLD = 0.015; // RMS threshold to consider "speaking"

let audioCtx = null;
let gainNode = null;
let currentVolume = 1.0;
let lipSyncRafId = null;

function getAudioContext() {
  if (!audioCtx || audioCtx.state === 'closed') {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    gainNode = audioCtx.createGain();
    gainNode.gain.value = currentVolume;
    gainNode.connect(audioCtx.destination);
  }
  return audioCtx;
}

function setVolume(value) {
  currentVolume = value;
  if (gainNode) {
    gainNode.gain.value = value;
  }
}

function setMouthOpen(open) {
  // mouth.png = closed mouth diff; hiding it reveals the open-mouth state
  mouthEl.style.display = open ? 'none' : 'block';
}

function stopLipSync() {
  if (lipSyncRafId !== null) {
    cancelAnimationFrame(lipSyncRafId);
    lipSyncRafId = null;
  }
  setMouthOpen(false); // closed
}

async function playAudio(base64, mimeType) {
  stopLipSync();

  const ctx = getAudioContext();
  if (ctx.state === 'suspended') {
    await ctx.resume();
  }

  // Decode base64 → ArrayBuffer
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  let audioBuffer;
  try {
    audioBuffer = await ctx.decodeAudioData(bytes.buffer);
  } catch (err) {
    console.error('Failed to decode audio:', err);
    return;
  }

  // Set up audio graph
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 256;
  const dataArray = new Float32Array(analyser.fftSize);

  const source = ctx.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(analyser);
  analyser.connect(gainNode);

  // Lip sync loop
  function lipSyncLoop() {
    analyser.getFloatTimeDomainData(dataArray);

    let sumSq = 0;
    for (const sample of dataArray) {
      sumSq += sample * sample;
    }
    const rms = Math.sqrt(sumSq / dataArray.length);

    setMouthOpen(rms > VOLUME_THRESHOLD);

    lipSyncRafId = requestAnimationFrame(lipSyncLoop);
  }

  source.onended = () => {
    stopLipSync();
  };

  source.start();
  lipSyncLoop();
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------
function connectWebSocket() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${protocol}//${location.host}`);

  ws.addEventListener('open', () => {
    console.log('WebSocket connected');
  });

  ws.addEventListener('message', (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (e) {
      console.error('Invalid WebSocket message:', e);
      return;
    }

    if (msg.type === 'audio') {
      playAudio(msg.data, msg.mimeType);
    } else if (msg.type === 'expression') {
      setExpression(msg.value);
    }
  });

  ws.addEventListener('close', () => {
    console.log('WebSocket disconnected. Reconnecting in 3s...');
    setTimeout(connectWebSocket, 3000);
  });

  ws.addEventListener('error', (err) => {
    console.error('WebSocket error:', err);
  });
}

// ---------------------------------------------------------------------------
// Pan / Zoom
// ---------------------------------------------------------------------------
const canvasEl = document.getElementById('canvas');
const stageEl  = document.getElementById('stage');

let scale   = 1;
let offsetX = 0;
let offsetY = 0;

const MIN_SCALE = 0.1;
const MAX_SCALE = 8;

function clampScale(s) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
}

function applyTransform() {
  stageEl.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`;
}

function zoomAt(cx, cy, factor) {
  const newScale = clampScale(scale * factor);
  offsetX = cx - (cx - offsetX) * (newScale / scale);
  offsetY = cy - (cy - offsetY) * (newScale / scale);
  scale = newScale;
  applyTransform();
}

// --- Mouse wheel zoom ---
canvasEl.addEventListener('wheel', (e) => {
  e.preventDefault();
  const rect = canvasEl.getBoundingClientRect();
  // Normalize across deltaMode (pixel / line / page)
  const lineH = 16;
  const pageH = canvasEl.clientHeight;
  const delta = e.deltaMode === 2 ? e.deltaY * pageH
              : e.deltaMode === 1 ? e.deltaY * lineH
              : e.deltaY;
  const factor = Math.pow(0.999, delta); // smooth, continuous
  zoomAt(e.clientX - rect.left, e.clientY - rect.top, factor);
}, { passive: false });

// --- Mouse drag ---
let isDragging  = false;
let dragStartX  = 0;
let dragStartY  = 0;
let dragOffsetX = 0;
let dragOffsetY = 0;

canvasEl.addEventListener('dragstart', (e) => e.preventDefault());

canvasEl.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  isDragging  = true;
  dragStartX  = e.clientX;
  dragStartY  = e.clientY;
  dragOffsetX = offsetX;
  dragOffsetY = offsetY;
  canvasEl.classList.add('dragging');
});

window.addEventListener('mousemove', (e) => {
  if (!isDragging) return;
  offsetX = dragOffsetX + (e.clientX - dragStartX);
  offsetY = dragOffsetY + (e.clientY - dragStartY);
  applyTransform();
});

window.addEventListener('mouseup', () => {
  if (!isDragging) return;
  isDragging = false;
  canvasEl.classList.remove('dragging');
});

// --- Touch: single-finger pan / two-finger pinch zoom ---
let touches      = {};   // id → {x, y}
let pinchDist    = null;
let pinchMidX    = 0;
let pinchMidY    = 0;
let touchPanX    = 0;
let touchPanY    = 0;
let touchOffsetX = 0;
let touchOffsetY = 0;

function activeTouches() { return Object.values(touches); }

canvasEl.addEventListener('touchstart', (e) => {
  e.preventDefault();
  for (const t of e.changedTouches) {
    touches[t.identifier] = { x: t.clientX, y: t.clientY };
  }
  const pts = activeTouches();
  if (pts.length === 1) {
    touchPanX    = pts[0].x;
    touchPanY    = pts[0].y;
    touchOffsetX = offsetX;
    touchOffsetY = offsetY;
    pinchDist    = null;
  } else if (pts.length === 2) {
    const rect = canvasEl.getBoundingClientRect();
    const dx = pts[1].x - pts[0].x;
    const dy = pts[1].y - pts[0].y;
    pinchDist = Math.sqrt(dx * dx + dy * dy);
    pinchMidX = (pts[0].x + pts[1].x) / 2 - rect.left;
    pinchMidY = (pts[0].y + pts[1].y) / 2 - rect.top;
  }
}, { passive: false });

canvasEl.addEventListener('touchmove', (e) => {
  e.preventDefault();
  for (const t of e.changedTouches) {
    touches[t.identifier] = { x: t.clientX, y: t.clientY };
  }
  const pts = activeTouches();
  const rect = canvasEl.getBoundingClientRect();

  if (pts.length === 1 && pinchDist === null) {
    offsetX = touchOffsetX + (pts[0].x - touchPanX);
    offsetY = touchOffsetY + (pts[0].y - touchPanY);
    applyTransform();
  } else if (pts.length >= 2 && pinchDist !== null) {
    const dx = pts[1].x - pts[0].x;
    const dy = pts[1].y - pts[0].y;
    const newDist = Math.sqrt(dx * dx + dy * dy);
    const midX = (pts[0].x + pts[1].x) / 2 - rect.left;
    const midY = (pts[0].y + pts[1].y) / 2 - rect.top;

    // Pan with midpoint movement
    offsetX += midX - pinchMidX;
    offsetY += midY - pinchMidY;

    // Zoom at midpoint
    zoomAt(midX, midY, newDist / pinchDist);

    pinchDist = newDist;
    pinchMidX = midX;
    pinchMidY = midY;
  }
}, { passive: false });

canvasEl.addEventListener('touchend', (e) => {
  for (const t of e.changedTouches) {
    delete touches[t.identifier];
  }
  const pts = activeTouches();
  if (pts.length < 2) pinchDist = null;
  if (pts.length === 1) {
    touchPanX    = pts[0].x;
    touchPanY    = pts[0].y;
    touchOffsetX = offsetX;
    touchOffsetY = offsetY;
  }
}, { passive: false });

canvasEl.addEventListener('touchcancel', (e) => {
  for (const t of e.changedTouches) delete touches[t.identifier];
  pinchDist = null;
});

// ---------------------------------------------------------------------------
// Effects: Bloom + Sparkle particles
// ---------------------------------------------------------------------------
const particleCanvas = document.getElementById('particles');
const pctx = particleCanvas.getContext('2d');

function resizeParticleCanvas() {
  particleCanvas.width  = particleCanvas.offsetWidth;
  particleCanvas.height = particleCanvas.offsetHeight;
}
resizeParticleCanvas();
window.addEventListener('resize', resizeParticleCanvas);

const PARTICLE_MAX = 28;
const CYBER_COLORS = [
  [0, 240, 255],  // cyan only
];

class Particle {
  constructor() { this.init(); }

  init() {
    const W = particleCanvas.width;
    const H = particleCanvas.height;
    this.x  = W * (0.1 + Math.random() * 0.8);
    this.y  = H * (0.1 + Math.random() * 0.85);
    this.size = 3 + Math.random() * 7;
    this.dx = (Math.random() - 0.5) * 0.5;
    this.dy = -(0.15 + Math.random() * 0.35);
    this.rotation = Math.random() * Math.PI * 2;
    this.rotSpeed = (Math.random() - 0.5) * 0.025;
    this.life     = 0;
    this.maxLife  = 90 + Math.floor(Math.random() * 90);
    this.maxOpacity = 0.25 + Math.random() * 0.3;
    this.color = CYBER_COLORS[Math.floor(Math.random() * CYBER_COLORS.length)];
  }

  get opacity() {
    const p = this.life / this.maxLife;
    if (p < 0.15) return this.maxOpacity * (p / 0.15);
    if (p > 0.72) return this.maxOpacity * (1 - (p - 0.72) / 0.28);
    return this.maxOpacity;
  }

  update() {
    this.x        += this.dx;
    this.y        += this.dy;
    this.rotation += this.rotSpeed;
    this.life++;
    return this.life < this.maxLife;
  }

  draw(ctx) {
    const [r, g, b] = this.color;
    const s = this.size;

    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.rotate(this.rotation);
    ctx.globalAlpha = this.opacity;

    // Equilateral triangle (circumradius = s)
    ctx.beginPath();
    ctx.moveTo(0,            -s);
    ctx.lineTo( s * 0.866,   s * 0.5);
    ctx.lineTo(-s * 0.866,   s * 0.5);
    ctx.closePath();

    // Translucent fill
    ctx.fillStyle = `rgba(${r},${g},${b},0.22)`;
    ctx.shadowBlur   = 0;
    ctx.fill();

    // Outer glow stroke
    ctx.shadowColor  = `rgb(${r},${g},${b})`;
    ctx.shadowBlur   = 22;
    ctx.strokeStyle  = `rgba(${r},${g},${b},0.55)`;
    ctx.lineWidth    = 2.8;
    ctx.stroke();

    // Sharp bright edge on top
    ctx.shadowBlur   = 5;
    ctx.strokeStyle  = `rgba(${r},${g},${b},1)`;
    ctx.lineWidth    = 1.0;
    ctx.stroke();

    ctx.restore();
  }
}

const particles = [];
let particleRafId = null;
let effectsEnabled = true;

function particleLoop() {
  pctx.clearRect(0, 0, particleCanvas.width, particleCanvas.height);

  if (particles.length < PARTICLE_MAX && Math.random() < 0.35) {
    particles.push(new Particle());
  }

  for (let i = particles.length - 1; i >= 0; i--) {
    if (!particles[i].update()) {
      particles.splice(i, 1);
    } else {
      particles[i].draw(pctx);
    }
  }

  particleRafId = requestAnimationFrame(particleLoop);
}

function setEffects(enabled) {
  effectsEnabled = enabled;
  document.getElementById('btn-effects').classList.toggle('active', enabled);
  if (enabled) {
    characterEl.classList.add('bloom');
    if (!particleRafId) particleLoop();
  } else {
    characterEl.classList.remove('bloom');
    cancelAnimationFrame(particleRafId);
    particleRafId = null;
    pctx.clearRect(0, 0, particleCanvas.width, particleCanvas.height);
    particles.length = 0;
  }
}

document.getElementById('btn-effects').addEventListener('click', () => {
  setEffects(!effectsEnabled);
});

// ---------------------------------------------------------------------------
// Breathing animation
// ---------------------------------------------------------------------------
const characterEl = document.getElementById('character');

const BREATH_PERIOD    = 4000;  // ms per full breath cycle
const BREATH_AMPLITUDE = 0.012; // scaleY variation (1.2% stretch)

function breathLoop(timestamp) {
  // Smooth 0→1→0 sine curve: inhale then exhale
  const phase  = (timestamp % BREATH_PERIOD) / BREATH_PERIOD;
  const breath = (1 - Math.cos(phase * 2 * Math.PI)) / 2;
  characterEl.style.transform = `scaleY(${1 + BREATH_AMPLITUDE * breath})`;
  requestAnimationFrame(breathLoop);
}

requestAnimationFrame(breathLoop);

// ---------------------------------------------------------------------------
// Control panel
// ---------------------------------------------------------------------------
document.getElementById('btn-replay').addEventListener('click', async () => {
  const res = await fetch('/api/replay');
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    console.warn('Replay:', err.error || 'failed');
  }
});

document.getElementById('volume-slider').addEventListener('input', (e) => {
  setVolume(parseFloat(e.target.value));
});

// Expression buttons
document.querySelectorAll('.btn-expr').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const expr = btn.dataset.expr;
    const res = await fetch('/api/expression', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expression: expr }),
    });
    if (res.ok) {
      document.querySelectorAll('.btn-expr').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    }
  });
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
// Start with normal eyes, closed mouth, no smile
setEyeState('normal');
setMouthOpen(false);
setExpression('normal');

// Start blink loop
blink();

// Start effects
setEffects(true);

// Connect to server
connectWebSocket();
