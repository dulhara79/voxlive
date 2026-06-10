'use strict';
require('dotenv').config();

const http      = require('http');
const express   = require('express');
const cors      = require('cors');
const WebSocket = require('ws');
const speech    = require('@google-cloud/speech');

// ── Config ─────────────────────────────────────────────────────────────────
const PORT           = parseInt(process.env.PORT || '8080', 10);
const PROJECT_ID     = process.env.GOOGLE_CLOUD_PROJECT;
const LOCATION       = process.env.SPEECH_LOCATION || 'us-central1';
const ALLOWED_ORIGIN = (process.env.ALLOWED_ORIGIN || 'http://localhost:5173')
                         .split(',').map(s => s.trim());

// Proactively restart the Speech stream before Google's 5-min hard limit
const STREAM_RESTART_MS          = 4 * 60 * 1000; // 4 minutes
const MAX_BUFFER_CHUNKS_ON_RESTART = 80;           // ~20 s of audio at 250 ms/chunk

if (!PROJECT_ID) {
  console.error('[VoxLive] GOOGLE_CLOUD_PROJECT is required');
  process.exit(1);
}

// ── Speech client (v2 / Chirp) ─────────────────────────────────────────────
const speechClient = new speech.v2.SpeechClient();

const RECOGNIZER_PATH = `projects/${PROJECT_ID}/locations/${LOCATION}/recognizers/_`;

/**
 * StreamingConfig sent as the first message on every new Speech stream.
 * languageCodes enables automatic language identification across all three
 * languages; Chirp returns the detected languageCode on each result.
 *
 * Use model: 'chirp_2' if available in your project for better code-switching.
 */
const STREAMING_CONFIG = {
  config: {
    explicitDecodingConfig: {
      encoding:          'LINEAR16',
      sampleRateHertz:   16000,
      audioChannelCount: 1,
    },
    languageCodes: ['si-LK', 'ta-LK', 'ta-IN', 'en-US', 'en-IN'],
    model:         'chirp',
    features: {
      enableAutomaticPunctuation: true,
    },
  },
  interimResults: true,
};

// ── HTTP / WS server ───────────────────────────────────────────────────────
const app = express();
app.use(cors({ origin: ALLOWED_ORIGIN, credentials: true }));
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), connections: wss.clients.size });
});

const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

// ── Per-connection logic ───────────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  const id = Math.random().toString(36).slice(2, 8).toUpperCase();
  const ip = req.socket.remoteAddress;
  console.log(`[${id}] Connected from ${ip}`);

  let speechStream    = null;
  let restartTimer    = null;
  let isRecording     = false;
  let isRestarting    = false;
  let audioBuffer     = [];   // chunks buffered during stream restart

  // ── Send helpers ──────────────────────────────────────────────────────
  const sendJson = (obj) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  };

  // ── Speech stream factory ─────────────────────────────────────────────
  const openSpeechStream = () => {
    const stream = speechClient.streamingRecognize();

    stream.on('data', (response) => {
      if (!response.results?.length) return;
      const result = response.results[0];
      if (!result.alternatives?.length) return;

      const alt        = result.alternatives[0];
      const isFinal    = result.isFinal ?? false;
      const langCode   = result.languageCode || 'en-US';
      const confidence = isFinal ? (alt.confidence ?? 0) : 0;
      const stability  = isFinal ? 0 : (result.stability ?? 0);

      sendJson({
        type:        'transcription',
        transcript:  alt.transcript,
        isFinal,
        languageCode: langCode,
        confidence,
        stability,
        timestamp:   Date.now(),
      });
    });

    stream.on('error', (err) => {
      // Code 11 = DEADLINE_EXCEEDED (5-min hard limit reached)
      // Code 4  = DEADLINE_EXCEEDED variant
      const isLimitErr = err.code === 11 || err.code === 4 ||
        (err.message || '').toLowerCase().includes('exceeded maximum');

      if (isLimitErr) {
        console.warn(`[${id}] Google hard limit hit — restarting`);
        scheduleRestart(0);
      } else {
        console.error(`[${id}] Speech error [${err.code}]: ${err.message}`);
        sendJson({ type: 'error', message: err.message });
      }
    });

    stream.on('end', () => console.log(`[${id}] Speech stream ended`));

    // First write: recognizer path + streaming config
    stream.write({
      recognizer:      RECOGNIZER_PATH,
      streamingConfig: STREAMING_CONFIG,
    });

    return stream;
  };

  // ── Proactive stream restart ──────────────────────────────────────────
  const scheduleRestart = (delayMs = 200) => {
    if (isRestarting) return;
    isRestarting = true;

    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }

    // Gracefully end old stream
    if (speechStream) {
      try { speechStream.end(); } catch (_) {}
      speechStream = null;
    }

    setTimeout(() => {
      if (!isRecording || ws.readyState !== WebSocket.OPEN) {
        isRestarting = false;
        return;
      }

      speechStream = openSpeechStream();
      console.log(`[${id}] Speech stream restarted`);

      // Drain buffered audio
      const pending = audioBuffer.splice(0);
      for (const chunk of pending) {
        try { speechStream.write({ audio: chunk }); } catch (_) {}
      }

      // Schedule the next proactive restart
      restartTimer = setTimeout(() => scheduleRestart(), STREAM_RESTART_MS);
      isRestarting = false;
    }, delayMs);
  };

  // ── WebSocket message handler ─────────────────────────────────────────
  ws.on('message', (data, isBinary) => {
    // ── Control messages (JSON text) ────────────────────────────────────
    if (!isBinary) {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }

      if (msg.type === 'start') {
        if (isRecording) return; // idempotent
        isRecording = true;
        audioBuffer = [];
        speechStream = openSpeechStream();
        restartTimer = setTimeout(() => scheduleRestart(), STREAM_RESTART_MS);
        sendJson({ type: 'status', status: 'recording' });
        console.log(`[${id}] Recording started`);

      } else if (msg.type === 'stop') {
        isRecording = false;
        audioBuffer = [];
        if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
        if (speechStream) { try { speechStream.end(); } catch (_) {} speechStream = null; }
        sendJson({ type: 'status', status: 'stopped' });
        console.log(`[${id}] Recording stopped`);
      }
      return;
    }

    // ── Raw PCM audio (binary) ──────────────────────────────────────────
    if (!isRecording) return;

    if (isRestarting) {
      if (audioBuffer.length < MAX_BUFFER_CHUNKS_ON_RESTART) {
        audioBuffer.push(data);           // keep streaming during restart
      }
      return;
    }

    if (speechStream) {
      try {
        speechStream.write({ audio: data });
      } catch (err) {
        console.error(`[${id}] Write error: ${err.message}`);
      }
    }
  });

  // ── Teardown ──────────────────────────────────────────────────────────
  ws.on('close', (code) => {
    console.log(`[${id}] Disconnected (${code})`);
    isRecording = false;
    if (restartTimer) clearTimeout(restartTimer);
    if (speechStream) { try { speechStream.end(); } catch (_) {} }
  });

  ws.on('error', (err) => console.error(`[${id}] WS error: ${err.message}`));
});

// ── Graceful shutdown ──────────────────────────────────────────────────────
const shutdown = (signal) => {
  console.log(`[VoxLive] ${signal} — shutting down`);
  wss.clients.forEach(ws => ws.close(1001, 'Server shutting down'));
  server.close(() => {
    console.log('[VoxLive] Closed');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// ── Start ──────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`[VoxLive] Backend ready on :${PORT}`);
  console.log(`[VoxLive] GCP project: ${PROJECT_ID}  location: ${LOCATION}`);
  console.log(`[VoxLive] CORS origin: ${ALLOWED_ORIGIN.join(', ')}`);
});
