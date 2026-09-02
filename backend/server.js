/**
 * VoxLive backend — real-time Sinhala / Tamil / English transcription
 * =============================================================================
 * STRATEGY: parallel single-language streams + confidence arbitration.
 *
 *   One dedicated Google Speech-to-Text v1p1beta1 SINGLE-language stream is run
 *   per language, all fed the SAME microphone audio:
 *       si-LK stream  → accurate Sinhala
 *       en-US stream  → accurate English
 *       ta-IN stream  → accurate Tamil
 *   For every spoken utterance each stream returns its best guess WITH a
 *   confidence score. An arbitrator emits only the HIGHEST-confidence result.
 *
 *   This replaces Google's single multi-language stream, which:
 *     - forced one "primary" language (si-LK) → English audio came out Sinhala,
 *     - labelled whole 30–60 s utterances as ONE language → mixed speech mangled.
 *
 *   Because every stream is a single-language Google model, their confidences
 *   are directly comparable, so picking the best one routes the language
 *   correctly and uses the most accurate per-language acoustic model.
 *
 *   Cost note: running N languages = N× STT cost. Select only the languages in
 *   play (via the UI cards) to control it. Selecting nothing → all three.
 *
 *   Limit (unchanged): a single heavily code-mixed utterance still resolves to
 *   one language. No engine does true intra-sentence trilingual splitting.
 *
 * Long sessions (1 hr+): each stream restarts every 4 min (before Google's ~5
 *   min cap) and replays its un-finalised tail — no speech lost at the seam.
 *
 * Wire protocol (unchanged — your existing frontend works as-is):
 *   Client → server:  {type:'start', mode, languageCodes:[...]} then binary
 *                     LINEAR16 PCM frames, then {type:'stop'}
 *   Server → client:  {type:'path', ...}
 *                     {type:'transcription', transcript, isFinal, languageCode,
 *                      confidence, timestamp}
 *                     {type:'error', message}
 * -----------------------------------------------------------------------------
 * Environment variables:
 *   PORT (8080) · ALLOWED_ORIGIN (http://localhost:5173)
 *   SPEECH_MODEL ('default'; try 'latest_long' for long-form if si-LK works)
 *   USE_ENHANCED ('false') · SPEECH_BOOST ('15')
 *   SPEECH_PHRASES_FILE (optional JSON array of bias phrases)
 *   GOOGLE_APPLICATION_CREDENTIALS (service-account key for local/dev)
 * =============================================================================
 */

"use strict";

require("dotenv").config();

const fs = require("fs");
const http = require("http");
const express = require("express");
const cors = require("cors");
const { WebSocketServer } = require("ws");

// v1p1beta1 keeps parity with the speechContexts / config surface we use.
const speech = require("@google-cloud/speech").v1p1beta1;

// ── Config ───────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || "8080", 10);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "http://localhost:5173";
const SPEECH_MODEL = process.env.SPEECH_MODEL || "default";
const USE_ENHANCED = String(process.env.USE_ENHANCED).toLowerCase() === "true";
const SPEECH_BOOST = parseFloat(process.env.SPEECH_BOOST || "15");

const SAMPLE_RATE = 16000; // must match the AudioWorklet (16 kHz, Int16, mono)
const STREAM_RESTART_MS = 4 * 60 * 1000; // restart before the ~5 min hard limit
const MAX_PENDING_BYTES = SAMPLE_RATE * 2 * 30; // ~30 s replay-buffer cap
const HEARTBEAT_MS = 30 * 1000;

// Arbitration timing.
const FINAL_GROUP_MS = 700; // collect competing finals for one utterance
const STRAGGLER_SUPPRESS_MS = 400; // ignore laggy duplicate finals after a flush
const INTERIM_STALE_MS = 1500; // ignore interim previews older than this

// ── Speech adaptation (phrase hints) ─────────────────────────────────────────
// Biggest no-training accuracy lever. Add expected words: names, jargon, common
// Sinhala/Tamil phrases. Extend inline or load via SPEECH_PHRASES_FILE.
let SPEECH_PHRASES = [
  // 'ආයුබෝවන්', 'ස්තූතියි', 'SLIIT', 'machine learning', 'வணக்கம்',
];
if (process.env.SPEECH_PHRASES_FILE) {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(process.env.SPEECH_PHRASES_FILE, "utf8"),
    );
    if (Array.isArray(parsed)) {
      SPEECH_PHRASES = parsed.filter((p) => typeof p === "string" && p.trim());
    }
  } catch (e) {
    console.warn("[VoxLive] Could not load SPEECH_PHRASES_FILE:", e.message);
  }
}

// ── Language handling ────────────────────────────────────────────────────────
// Frontend sends ta-LK; Google uses ta-IN for Tamil. Map on the way in.
const TO_GOOGLE = { "si-LK": "si-LK", "ta-LK": "ta-IN", "en-US": "en-US" };
const SUPPORTED = new Set(Object.values(TO_GOOGLE));
const DEFAULT_LANGS = ["si-LK", "en-US", "ta-IN"];

function resolveLangs(selected) {
  const mapped = [];
  for (const code of Array.isArray(selected) ? selected : []) {
    const g = TO_GOOGLE[code];
    if (g && SUPPORTED.has(g) && !mapped.includes(g)) mapped.push(g);
  }
  return mapped.length > 0 ? mapped : DEFAULT_LANGS.slice();
}

// ── Google client (one per process, reused across connections) ───────────────
const speechClient = new speech.SpeechClient();

// ── One single-language Google stream (self-healing) ─────────────────────────
class LangStream {
  /**
   * @param {string} googleLang  e.g. 'si-LK'
   * @param {object} handlers    { onResult(payload), onError(lang, err) }
   */
  constructor(googleLang, handlers) {
    this.googleLang = googleLang;
    this.handlers = handlers;
    this.stream = null;
    this.restartTimer = null;
    this.pending = [];
    this.pendingBytes = 0;
    this.closed = false;
    this.open();
  }

  buildRequest() {
    const config = {
      encoding: "LINEAR16",
      sampleRateHertz: SAMPLE_RATE,
      audioChannelCount: 1,
      languageCode: this.googleLang, // SINGLE language — accurate, no hedging
      model: SPEECH_MODEL,
      enableAutomaticPunctuation: true,
      maxAlternatives: 1,
    };
    if (USE_ENHANCED) config.useEnhanced = true;
    if (SPEECH_PHRASES.length > 0) {
      config.speechContexts = [
        { phrases: SPEECH_PHRASES, boost: SPEECH_BOOST },
      ];
    }
    return { config, interimResults: true };
  }

  open() {
    if (this.closed) return;
    const stream = speechClient
      .streamingRecognize(this.buildRequest())
      // Identity guard makes restarts race-free (stale events ignored).
      .on("error", (err) => {
        if (this.stream === stream) this.onError(err);
      })
      .on("data", (data) => {
        if (this.stream === stream) this.onData(data);
      });

    this.stream = stream;

    for (const chunk of this.pending) {
      try {
        stream.write(chunk);
      } catch (_) {
        /* retried on next live write */
      }
    }

    clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => this.restart(), STREAM_RESTART_MS);
  }

  restart() {
    if (this.closed) return;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const old = this.stream;
    this.stream = null;
    this.open();
    if (old) {
      try {
        old.end();
      } catch (_) {
        /* already closed */
      }
    }
  }

  onData(data) {
    const result = data.results && data.results[0];
    if (!result || !result.alternatives || !result.alternatives[0]) return;

    const alt = result.alternatives[0];
    const isFinal = !!result.isFinal;

    // A final means this stream's buffered audio is transcribed — drop it so a
    // restart never replays (and duplicates) finalised speech.
    if (isFinal) {
      this.pending = [];
      this.pendingBytes = 0;
    }

    this.handlers.onResult({
      googleLang: this.googleLang,
      transcript: alt.transcript || "",
      isFinal,
      confidence: typeof alt.confidence === "number" ? alt.confidence : 0,
      stability: typeof result.stability === "number" ? result.stability : 0,
    });
  }

  onError(err) {
    const code = err && err.code;
    if (code === 11) {
      // OUT_OF_RANGE → hit stream length limit. Rotate.
      this.restart();
      return;
    }
    this.handlers.onError(this.googleLang, err);
    // 3 = INVALID_ARGUMENT (e.g. model doesn't support this language): give up
    // on THIS language only; the other language streams keep running.
    if (!this.closed && code !== 3) this.restart();
  }

  write(chunk) {
    if (this.closed || !this.stream) return;
    this.pending.push(chunk);
    this.pendingBytes += chunk.length;
    while (this.pendingBytes > MAX_PENDING_BYTES && this.pending.length > 1) {
      this.pendingBytes -= this.pending.shift().length;
    }
    try {
      this.stream.write(chunk);
    } catch (_) {
      // mid-rotation; chunk preserved in pending for replay
    }
  }

  end() {
    this.closed = true;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    if (this.stream) {
      const s = this.stream;
      this.stream = null;
      try {
        s.end();
      } catch (_) {
        /* already closed */
      }
    }
    this.pending = [];
    this.pendingBytes = 0;
  }
}

// ── Per-connection session: fans audio out, arbitrates results ───────────────
class TranscriptionSession {
  constructor(ws) {
    this.ws = ws;
    this.langStreams = [];
    this.closed = false;
    this.errorCount = 0;
    this.resetArbitration();
  }

  resetArbitration() {
    this.finalBuffer = [];
    clearTimeout(this.finalTimer);
    this.finalTimer = null;
    this.lastFlushAt = 0;
    this.interimByLang = {}; // lang -> {text, stability, at}
    this.stabilityByLang = {}; // lang -> max stability seen this utterance
  }

  send(obj) {
    if (this.ws.readyState === this.ws.OPEN) {
      try {
        this.ws.send(JSON.stringify(obj));
      } catch (_) {
        /* socket gone */
      }
    }
  }

  teardownStreams() {
    for (const ls of this.langStreams) ls.end();
    this.langStreams = [];
  }

  /**
   * (Re)initialise. A fresh start fully tears down old streams and arbitration
   * state, so a previous recording's language/audio can NEVER leak into the new
   * one.
   */
  start(selected) {
    if (this.closed) return;
    this.teardownStreams();
    this.resetArbitration();
    this.errorCount = 0;

    const langs = resolveLangs(selected);
    console.log(
      `[VoxLive] start  parallel single-language streams: [${langs.join(", ")}]` +
        `  model=${SPEECH_MODEL}`,
    );
    this.send({
      type: "path",
      path: "parallel",
      languages: langs,
      model: SPEECH_MODEL,
    });

    const handlers = {
      onResult: (r) => this.onResult(r),
      onError: (lang, err) => this.onStreamError(lang, err),
    };
    this.langStreams = langs.map((l) => new LangStream(l, handlers));
  }

  writeAudio(chunk) {
    for (const ls of this.langStreams) ls.write(chunk);
  }

  onResult(r) {
    if (this.closed) return;
    if (r.isFinal) {
      if (!r.transcript || !r.transcript.trim()) return;
      this.errorCount = 0;

      // Suppress laggy duplicates of the utterance we just emitted.
      if (Date.now() - this.lastFlushAt < STRAGGLER_SUPPRESS_MS) return;

      this.finalBuffer.push(r);
      if (!this.finalTimer) {
        this.finalTimer = setTimeout(() => this.flushFinals(), FINAL_GROUP_MS);
      }
    } else {
      this.handleInterim(r);
    }
  }

  flushFinals() {
    this.finalTimer = null;
    const buf = this.finalBuffer;
    this.finalBuffer = [];
    if (buf.length === 0) return;

    // Pick the highest-confidence final. If confidences are all 0 (some models
    // omit them), fall back to the language with the strongest interim
    // stability during this utterance.
    const maxConf = buf.reduce((m, f) => Math.max(m, f.confidence), 0);
    let best;
    if (maxConf > 0) {
      best = buf.reduce((a, b) => (b.confidence > a.confidence ? b : a));
    } else {
      best = buf.reduce((a, b) => {
        const sa = this.stabilityByLang[a.googleLang] || 0;
        const sb = this.stabilityByLang[b.googleLang] || 0;
        return sb > sa ? b : a;
      });
    }

    this.lastFlushAt = Date.now();
    this.interimByLang = {};
    this.stabilityByLang = {};

    this.send({
      type: "transcription",
      transcript: best.transcript,
      isFinal: true,
      languageCode: best.googleLang,
      confidence: best.confidence,
      timestamp: Date.now(),
    });
  }

  handleInterim(r) {
    const now = Date.now();
    this.interimByLang[r.googleLang] = {
      text: r.transcript,
      stability: r.stability,
      at: now,
    };
    if (r.stability > (this.stabilityByLang[r.googleLang] || 0)) {
      this.stabilityByLang[r.googleLang] = r.stability;
    }

    // Show the live preview from whichever stream is currently most stable
    // (i.e. most confident the text won't change) → follows the spoken language.
    let bestLang = null;
    let bestStab = -1;
    for (const lang of Object.keys(this.interimByLang)) {
      const v = this.interimByLang[lang];
      if (now - v.at > INTERIM_STALE_MS) continue;
      if (v.stability > bestStab) {
        bestStab = v.stability;
        bestLang = lang;
      }
    }
    if (!bestLang) return;
    const v = this.interimByLang[bestLang];
    if (!v.text) return;

    this.send({
      type: "transcription",
      transcript: v.text,
      isFinal: false,
      languageCode: bestLang,
      confidence: 0,
      timestamp: now,
    });
  }

  onStreamError(lang, err) {
    const code = err && err.code;
    const msg = (err && err.message) || String(err);
    console.error(`[VoxLive] [${lang}] stream error:`, code, msg);

    this.errorCount += 1;

    if (code === 3 || /language|model|not.*support|invalid/i.test(msg)) {
      // This language can't run on the current model — tell the user, but the
      // other language streams keep working.
      this.send({
        type: "error",
        message:
          `Language ${lang} was rejected on model "${SPEECH_MODEL}". ` +
          "Other languages will continue. Try SPEECH_MODEL=default if Sinhala fails.",
      });
      return;
    }

    if (this.errorCount > 8) {
      this.send({
        type: "error",
        message: "Transcription is unstable. Please stop and try again.",
      });
    }
  }

  stop() {
    this.teardownStreams();
    this.resetArbitration();
  }

  destroy() {
    if (this.closed) return;
    this.closed = true;
    this.teardownStreams();
    this.resetArbitration();
  }
}

// ── HTTP + WebSocket server ──────────────────────────────────────────────────
const app = express();
app.use(cors({ origin: ALLOWED_ORIGIN }));
app.get("/health", (_req, res) => res.status(200).send("ok"));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  console.log("[VoxLive] client connected");
  const session = new TranscriptionSession(ws);

  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      session.writeAudio(data); // raw LINEAR16 PCM frame
      return;
    }
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (_) {
      return;
    }
    if (msg.type === "start") {
      session.start(msg.languageCodes);
    } else if (msg.type === "stop") {
      session.stop();
    }
  });

  ws.on("close", () => {
    console.log("[VoxLive] client disconnected");
    session.destroy();
  });

  ws.on("error", (err) => {
    console.error(
      "[VoxLive] socket error:",
      err && err.message ? err.message : err,
    );
    session.destroy();
  });
});

// Heartbeat — terminate sockets that stop answering pings.
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch (_) {
      /* ignore */
    }
  });
}, HEARTBEAT_MS);

wss.on("close", () => clearInterval(heartbeat));

server.listen(PORT, () => {
  console.log(`[VoxLive] backend listening on :${PORT}`);
  console.log(`[VoxLive] model=${SPEECH_MODEL}  useEnhanced=${USE_ENHANCED}`);
  console.log(
    `[VoxLive] phrase hints: ${SPEECH_PHRASES.length}  boost=${SPEECH_BOOST}`,
  );
  console.log(`[VoxLive] allowed origin: ${ALLOWED_ORIGIN}`);
});

// Graceful shutdown (Cloud Run / GKE send SIGTERM).
function shutdown(signal) {
  console.log(`[VoxLive] ${signal} received — shutting down.`);
  clearInterval(heartbeat);
  wss.clients.forEach((ws) => {
    try {
      ws.close();
    } catch (_) {
      /* ignore */
    }
  });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
