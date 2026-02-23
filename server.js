const express = require('express');
const multer = require('multer');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/images', express.static(path.join(__dirname, 'images')));

const clients = new Set();
let lastAudio = null; // stores the most recently received audio for replay

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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`PNG Assistant server running at http://localhost:${PORT}`);
  console.log('WebSocket server ready');
  loadLatestAudioFile();
  console.log(`Watching ${__dirname} for audio file changes...`);
});
