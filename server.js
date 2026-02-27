const express = require('express');
const multer = require('multer');
const http = require('http');
// WebSocket: GatewayWs is used as a client to the OpenClaw Gateway;
// WebSocketServer is used to accept browser connections.
const { WebSocket: GatewayWs, WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto'); // for idempotency keys (built-in, no extra dep)

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/images', express.static(path.join(__dirname, 'images')));

const clients = new Set();
let lastAudio = null; // stores the most recently received audio for replay

// ---------------------------------------------------------------------------
// OpenClaw Gateway WebSocket client (Stage 1)
//
// The token is read from OPENCLAW_GATEWAY_TOKEN env var and is NEVER sent to
// the browser. All gateway communication happens server-side only.
//
// NOTE:
// OpenClaw's Gateway WS is an RPC protocol. It always sends a pre-connect
// challenge event and expects the client to respond with a `connect` *request*
// frame that includes a signed nonce.
//
// Protocol (simplified):
//   Gateway → event:connect.challenge { nonce, ts }
//   Client → req:connect { params: { auth:{token}, device:{signature, nonce, ...}, ... } }
//   Gateway → res:hello-ok
//
// Chat usage:
//   Client → req:chat.send { sessionKey, message, deliver:false, idempotencyKey }
//   Gateway → event:chat { state:"delta"|"final"|"error", runId, message/errorMessage }
// ---------------------------------------------------------------------------
const GATEWAY_WS_URL  = process.env.OPENCLAW_GATEWAY_WS_URL  || 'ws://127.0.0.1:18789/ws';
const SESSION_KEY     = process.env.OPENCLAW_SESSION_KEY      || 'agent:main:main';
// Token is intentionally NOT exported to browsers – kept server-side only.
const GATEWAY_TOKEN   = process.env.OPENCLAW_GATEWAY_TOKEN    || '';

const GATEWAY_BACKOFF_MAX = 30_000; // cap reconnect delay at 30 s

let gatewayWs        = null;  // active GatewayWs instance
let gatewayReady     = false; // true after hello-ok
let gatewayBackoff   = 1_000; // current reconnect delay (ms)
let gatewayLastNonce = null;  // last connect.challenge nonce

const DEVICE_FILE = path.join(__dirname, '.openclaw-device.json');

function b64urlEncode(bytes) {
  return Buffer.from(bytes)
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/g, '');
}

function b64urlDecode(value) {
  const v = String(value || '').replaceAll('-', '+').replaceAll('_', '/');
  const padded = v + '='.repeat((4 - (v.length % 4)) % 4);
  return Buffer.from(padded, 'base64');
}

function sha256Hex(buf) {
  return require('crypto').createHash('sha256').update(buf).digest('hex');
}

function extractEd25519RawPublicKeyFromSpki(spkiDer) {
  // RFC8410 SPKI for Ed25519 ends with: 03 21 00 <32-byte pubkey>
  const buf = Buffer.from(spkiDer);
  const marker = Buffer.from([0x03, 0x21, 0x00]);
  const idx = buf.lastIndexOf(marker);
  if (idx >= 0 && idx + marker.length + 32 <= buf.length) {
    return buf.subarray(idx + marker.length, idx + marker.length + 32);
  }
  // Fallback: last 32 bytes
  return buf.subarray(buf.length - 32);
}

function extractEd25519SeedFromPkcs8(pkcs8Der) {
  // RFC8410 PKCS8 for Ed25519 includes: 04 20 <32-byte seed>
  const buf = Buffer.from(pkcs8Der);
  const marker = Buffer.from([0x04, 0x20]);
  const idx = buf.lastIndexOf(marker);
  if (idx >= 0 && idx + marker.length + 32 <= buf.length) {
    return buf.subarray(idx + marker.length, idx + marker.length + 32);
  }
  // Fallback: last 32 bytes
  return buf.subarray(buf.length - 32);
}

function loadOrCreateDevice() {
  // Persist a local Ed25519 keypair so the gateway can recognize the client.
  // IMPORTANT: Gateway validates that device.id matches SHA-256(publicKeyRaw) as hex.
  // Control UI does: deviceId = hex(sha256(publicKeyRawBytes)).
  try {
    if (fs.existsSync(DEVICE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DEVICE_FILE, 'utf8'));
      if (parsed && parsed.id && parsed.publicKey && parsed.privateKeyPem) {
        return parsed;
      }
    }
  } catch (e) {
    console.warn('[gateway] Failed to load device file, regenerating:', e.message);
  }

  const crypto = require('crypto');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');

  const publicKeySpkiDer = publicKey.export({ type: 'spki', format: 'der' });
  const privateKeyPkcs8Der = privateKey.export({ type: 'pkcs8', format: 'der' });
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });

  const publicKeyRaw = extractEd25519RawPublicKeyFromSpki(publicKeySpkiDer);
  const seedRaw = extractEd25519SeedFromPkcs8(privateKeyPkcs8Der);

  const id = sha256Hex(publicKeyRaw); // hex string
  const device = {
    id,
    publicKey: b64urlEncode(publicKeyRaw), // base64url (like Control UI)
    // Keep PEM for Node's crypto.sign
    privateKeyPem,
    // Optional: store seed for debugging/interop
    privateKeySeed: b64urlEncode(seedRaw),
  };

  try {
    fs.writeFileSync(DEVICE_FILE, JSON.stringify(device, null, 2));
  } catch (e) {
    console.warn('[gateway] Failed to write device file:', e.message);
  }
  return device;
}

// Identify as a backend gateway client (not a browser/webchat client).
// This avoids browser-origin checks and matches the gateway's strict enums.
const GATEWAY_CLIENT_ID = 'gateway-client';
const GATEWAY_CLIENT_MODE = 'backend';

function signNonce(device, nonce, signedAtMs) {
  const crypto = require('crypto');
  // Match the signing string format used by the Control UI/web clients.
  // Format: v2|deviceId|clientId|clientMode|role|scopes|signedAtMs|token|nonce
  const role = 'operator';
  const scopes = ['operator.admin', 'operator.approvals', 'operator.pairing'];
  const token = GATEWAY_TOKEN || '';
  const signString = ['v2', device.id, GATEWAY_CLIENT_ID, GATEWAY_CLIENT_MODE, role, scopes.join(','), String(signedAtMs), token, nonce].join('|');
  const signature = crypto.sign(null, Buffer.from(signString, 'utf8'), device.privateKeyPem);
  return {
    signatureB64: b64urlEncode(signature),
    scopes,
    role,
    clientMode: GATEWAY_CLIENT_MODE,
    clientId: GATEWAY_CLIENT_ID,
    signString,
  };
}

function extractTextFromMessage(message) {
  if (!message) return '';
  if (typeof message === 'string') return message;
  if (typeof message.text === 'string') return message.text;
  // OpenAI/Anthropic-like shape: { role, content:[{type:"text", text:"..."}, ...] }
  const content = message.content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          if (typeof part.text === 'string') return part.text;
          if (typeof part.value === 'string') return part.value;
        }
        return '';
      })
      .join('');
  }
  return '';
}

function handleGatewayChatEvent(payload) {
  if (!payload || typeof payload !== 'object') return;
  const state = payload.state;
  const runId = payload.runId;

  if (state === 'delta') {
    const text = extractTextFromMessage(payload.message);
    if (text) broadcast({ type: 'chat.delta', runId, text });
    return;
  }

  if (state === 'final') {
    const text = extractTextFromMessage(payload.message);
    broadcast({ type: 'chat.final', runId, text, state: 'done' });
    return;
  }

  if (state === 'error') {
    broadcast({ type: 'chat.error', runId, error: payload.errorMessage || payload.error || 'chat error' });
    return;
  }

  if (state === 'aborted') {
    // Treat abort like final; keep whatever text we have.
    const text = extractTextFromMessage(payload.message);
    broadcast({ type: 'chat.final', runId, text, state: 'aborted' });
  }
}

function connectGateway() {
  if (!GATEWAY_TOKEN) {
    console.warn('[gateway] OPENCLAW_GATEWAY_TOKEN is not set – connect may fail if auth is required');
  }

  console.log(`[gateway] Connecting to ${GATEWAY_WS_URL} …`);
  const ws = new GatewayWs(GATEWAY_WS_URL);
  gatewayWs    = ws;
  gatewayReady = false;
  gatewayLastNonce = null;

  // Pending RPC requests: id -> { resolve, reject }
  const pending = new Map();

  // Expose a minimal request helper for /api/chat.
  gatewayWs.request = function request(method, params) {
    return new Promise((resolve, reject) => {
      if (!gatewayWs || gatewayWs.readyState !== 1) {
        reject(new Error('gateway not connected'));
        return;
      }
      const id = randomUUID();
      pending.set(id, { resolve, reject, method });
      gatewayWs.send(JSON.stringify({ type: 'req', id, method, params }));
    });
  };

  const device = loadOrCreateDevice();

  function sendConnect(nonce) {
    const signedAt = Date.now();
    const signed = signNonce(device, nonce, signedAt);

    gatewayWs.request('connect', {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        // NOTE: Gateway validates this against a strict enum.
        id: GATEWAY_CLIENT_ID,
        version: 'stage1',
        platform: process.platform,
        mode: GATEWAY_CLIENT_MODE,
      },
      role: signed.role,
      scopes: signed.scopes,
      caps: [],
      commands: [],
      permissions: {},
      auth: { token: GATEWAY_TOKEN || undefined },
      locale: 'ja-JP',
      userAgent: `png-assistant/${process.version}`,
      device: {
        id: device.id,
        publicKey: device.publicKey,
        signature: signed.signatureB64,
        signedAt,
        nonce,
      },
    }).catch((err) => {
      console.error('[gateway] connect failed:', err);
      try { ws.close(); } catch {}
    });
  }

  ws.on('open', () => {
    console.log('[gateway] TCP open. Waiting for connect.challenge…');
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'event') {
      if (msg.event === 'connect.challenge') {
        const nonce = msg.payload && msg.payload.nonce;
        if (typeof nonce === 'string' && nonce.trim()) {
          gatewayLastNonce = nonce;
          console.log('[gateway] Challenge received; sending connect request…');
          sendConnect(nonce);
        }
        return;
      }
      if (msg.event === 'chat') {
        handleGatewayChatEvent(msg.payload);
        return;
      }
      return;
    }

    if (msg.type === 'res') {
      const entry = pending.get(msg.id);
      if (entry) {
        pending.delete(msg.id);
        if (msg.ok) entry.resolve(msg.payload);
        else entry.reject(msg.error || msg);
      }

      if (msg.ok && msg.payload && msg.payload.type === 'hello-ok') {
        console.log('[gateway] hello-ok received; ready');
        gatewayReady   = true;
        gatewayBackoff = 1_000;
      } else if (!msg.ok) {
        console.error('[gateway] Request failed:', msg.error || msg);
      }
      return;
    }

    console.log('[gateway] Unhandled frame:', msg);
  });

  ws.on('close', (code) => {
    // Reject all pending RPCs.
    for (const { reject } of pending.values()) {
      try { reject(new Error(`gateway closed (${code})`)); } catch {}
    }
    pending.clear();

    gatewayReady = false;
    gatewayWs    = null;
    const delay  = gatewayBackoff;
    gatewayBackoff = Math.min(gatewayBackoff * 2, GATEWAY_BACKOFF_MAX);
    console.log(`[gateway] Disconnected (code ${code}). Reconnecting in ${delay} ms…`);
    setTimeout(connectGateway, delay);
  });

  ws.on('error', (err) => {
    console.error('[gateway] Error:', err.message);
  });
}

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`Client connected. Total: ${clients.size}`);

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`Client disconnected. Total: ${clients.size}`);
  });
});

function broadcast(message) {
  const data = JSON.stringify(message);
  for (const client of clients) {
    if (client.readyState === 1) {
      client.send(data);
    }
  }
}

// POST /api/speak - receive audio data and forward to all WebSocket clients
app.post('/api/speak', upload.single('audio'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No audio file provided. Use multipart/form-data with field name "audio".' });
  }

  const mimeType = req.file.mimetype || 'audio/wav';
  const base64 = req.file.buffer.toString('base64');

  lastAudio = { data: base64, mimeType };
  broadcast({ type: 'audio', data: base64, mimeType });

  console.log(`Audio received: ${req.file.originalname} (${req.file.size} bytes), mime: ${mimeType}`);
  res.json({ success: true });
});

// GET /api/replay - replay the last received audio
app.get('/api/replay', (req, res) => {
  if (!lastAudio) {
    return res.status(404).json({ error: 'No audio has been received yet.' });
  }
  broadcast({ type: 'audio', data: lastAudio.data, mimeType: lastAudio.mimeType });
  console.log('Replaying last audio');
  res.json({ success: true });
});

// POST /api/expression - change expression (normal/smile)
app.post('/api/expression', (req, res) => {
  const { expression } = req.body;
  if (!expression || !['normal', 'smile'].includes(expression)) {
    return res.status(400).json({ error: 'Invalid expression. Use "normal" or "smile".' });
  }

  broadcast({ type: 'expression', value: expression });

  console.log(`Expression changed to: ${expression}`);
  res.json({ success: true });
});

// Watch root directory for audio file changes (mp3/wav)
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg']);
const MIME_MAP = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg' };
const watchDebounce = {};

fs.watch(__dirname, (eventType, filename) => {
  if (!filename) return;
  const ext = path.extname(filename).toLowerCase();
  if (!AUDIO_EXTENSIONS.has(ext)) return;

  clearTimeout(watchDebounce[filename]);
  watchDebounce[filename] = setTimeout(() => {
    const filePath = path.join(__dirname, filename);
    fs.readFile(filePath, (err, data) => {
      if (err) return; // file may have been deleted
      const mimeType = MIME_MAP[ext] || 'audio/mpeg';
      const base64 = data.toString('base64');
      lastAudio = { data: base64, mimeType };
      broadcast({ type: 'audio', data: base64, mimeType });
      console.log(`File changed: ${filename} (${data.length} bytes) - broadcasting`);
    });
  }, 300);
});

// On startup, load the most recently modified audio file in the root directory
function loadLatestAudioFile() {
  const files = fs.readdirSync(__dirname)
    .filter(f => AUDIO_EXTENSIONS.has(path.extname(f).toLowerCase()))
    .map(f => ({ name: f, mtime: fs.statSync(path.join(__dirname, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  if (files.length === 0) return;
  const latest = files[0];
  const ext = path.extname(latest.name).toLowerCase();
  const data = fs.readFileSync(path.join(__dirname, latest.name));
  lastAudio = { data: data.toString('base64'), mimeType: MIME_MAP[ext] || 'audio/mpeg' };
  console.log(`Loaded for replay: ${latest.name}`);
}

// ---------------------------------------------------------------------------
// POST /api/chat  (Stage 1)
//
// Receives { text } from the browser, forwards it to the OpenClaw Gateway via
// chat.send, then streams the assistant's reply back to the browser over the
// existing WebSocket broadcast channel (chat.delta / chat.final / chat.error).
//
// The gateway token is never involved with this response – it stays server-side.
// ---------------------------------------------------------------------------
app.post('/api/chat', (req, res) => {
  const { text } = req.body;
  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'text field is required and must be a non-empty string' });
  }

  if (!gatewayReady || !gatewayWs) {
    return res.status(503).json({ error: 'Gateway not connected – please wait and retry' });
  }

  const idempotencyKey = randomUUID();

  // Send the chat message to the gateway via the RPC request frame.
  // deliver:false – do not auto-deliver to other channels; we consume events here.
  gatewayWs.request('chat.send', {
    sessionKey: SESSION_KEY,
    message: text.trim(),
    deliver: false,
    idempotencyKey,
  }).catch((err) => {
    console.error('[chat] chat.send failed:', err);
    broadcast({ type: 'chat.error', runId: idempotencyKey, error: err?.message || String(err) });
  });

  console.log(`[chat] Sent message (idempotencyKey=${idempotencyKey})`);

  // Acknowledge immediately; the assistant's reply will arrive as WebSocket
  // broadcast events (chat.delta / chat.final / chat.error).
  res.json({ ok: true, idempotencyKey });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`PNG Assistant server running at http://localhost:${PORT}`);
  console.log('WebSocket server ready');
  loadLatestAudioFile();
  console.log(`Watching ${__dirname} for audio file changes...`);
  // Connect to the OpenClaw Gateway on startup.
  connectGateway();
});
