"use strict";
require("dotenv").config();

const http = require("http");
const express = require("express");
const cors = require("cors");
const WebSocket = require("ws");
const speech = require("@google-cloud/speech");

// ── Config ─────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || "8080", 10);
const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT;
const LOCATION = process.env.SPEECH_LOCATION || "us-central1";
const ALLOWED_ORIGIN = (process.env.ALLOWED_ORIGIN || "http://localhost:5173")
  .split(",")
  .map((s) => s.trim());

// Chirp 2 is available in these regional locations only.
// 'global' is NOT a valid Speech-to-Text v2 location — it causes INVALID_ARGUMENT.
const CHIRP_VALID_LOCATIONS = new Set([
  "us-central1",
  "europe-west4",
  "asia-southeast1",
]);

// Proactively restart the Speech stream before Google's 5-min hard limit
const STREAM_RESTART_MS = 4 * 60 * 1000; // 4 minutes
const MAX_BUFFER_CHUNKS_ON_RESTART = 80; // ~20 s of audio at 250 ms/chunk

if (!PROJECT_ID) {
  console.error("[VoxLive] GOOGLE_CLOUD_PROJECT is required");
  process.exit(1);
}

if (!CHIRP_VALID_LOCATIONS.has(LOCATION)) {
  console.error(
    `[VoxLive] SPEECH_LOCATION="${LOCATION}" is not valid for Chirp 2.\n` +
      `         Valid locations: ${[...CHIRP_VALID_LOCATIONS].join(", ")}\n` +
      `         Update SPEECH_LOCATION in your .env — 'global' is NOT supported.`,
  );
  process.exit(1);
}

// ── Speech client (v2 / Chirp 2) ───────────────────────────────────────────
//
// IMPORTANT: Do NOT set apiEndpoint here.
//
// The global endpoint (speech.googleapis.com) handles Speech-to-Text v2
// requests for all locations. It uses the `locations/{location}` segment of
// the recognizer resource path to route internally to the correct region.
//
// Setting apiEndpoint to a regional host (e.g. us-central1-speech.googleapis.com)
// causes two problems:
//   1. The regional endpoint rejects the `_` wildcard inline recognizer with
//      INVALID_ARGUMENT: Invalid resource field value in the request.
//   2. It forces explicit OAuth scopes, changing the auth flow unexpectedly.
//
const speechClient = new speech.v2.SpeechClient();

const RECOGNIZER_PATH = `projects/${PROJECT_ID}/locations/${LOCATION}/recognizers/_`;

// ── Streaming config ────────────────────────────────────────────────────────
//
// model: "chirp_2"  ← REQUIRED for streaming.
//   • chirp   = batch/async transcription only. Using it with streamingRecognize
//               returns INVALID_ARGUMENT regardless of location or endpoint.
//   • chirp_2 = supports both streaming and batch. Needed here.
//
// If your GCP project doesn't have chirp_2 access yet, enable it in the
// GCP console under APIs & Services → Cloud Speech-to-Text API.
//
const STREAMING_CONFIG = {
  config: {
    // autoDecodingConfig lets Chirp 2 detect audio format automatically.
    // explicitDecodingConfig causes INVALID_ARGUMENT with Chirp streaming.
    autoDecodingConfig: {},
    languageCodes: ["si-LK", "ta-LK", "ta-IN", "en-US", "en-IN"],
    model: "chirp_3",
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

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    connections: wss.clients.size,
  });
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ── Per-connection logic ───────────────────────────────────────────────────
wss.on("connection", (ws, req) => {
  const id = Math.random().toString(36).slice(2, 8).toUpperCase();
  const ip = req.socket.remoteAddress;
  console.log(`[${id}] Connected from ${ip}`);

  let speechStream = null;
  let restartTimer = null;
  let isRecording = false;
  let isRestarting = false;
  let audioBuffer = []; // chunks buffered during stream restart

  // ── Send helpers ──────────────────────────────────────────────────────
  const sendJson = (obj) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  };

  // ── Speech stream factory ─────────────────────────────────────────────
  const openSpeechStream = () => {
    const stream = speechClient.streamingRecognize();

    stream.on("data", (response) => {
      if (!response.results?.length) return;
      const result = response.results[0];
      if (!result.alternatives?.length) return;

      const alt = result.alternatives[0];
      const isFinal = result.isFinal ?? false;
      const langCode = result.languageCode || "en-US";
      const confidence = isFinal ? (alt.confidence ?? 0) : 0;
      const stability = isFinal ? 0 : (result.stability ?? 0);

      sendJson({
        type: "transcription",
        transcript: alt.transcript,
        isFinal,
        languageCode: langCode,
        confidence,
        stability,
        timestamp: Date.now(),
      });
    });

    stream.on("error", (err) => {
      // Code 11 = DEADLINE_EXCEEDED (5-min hard limit reached)
      // Code 4  = DEADLINE_EXCEEDED variant
      const isLimitErr =
        err.code === 11 ||
        err.code === 4 ||
        (err.message || "").toLowerCase().includes("exceeded maximum");

      if (isLimitErr) {
        console.warn(`[${id}] Google hard limit hit — restarting`);
        scheduleRestart(0);
      } else {
        console.error(`[${id}] Speech error [${err.code}]: ${err.message}`);

        // Provide an actionable hint for the most common misconfiguration
        if (err.code === 3) {
          console.error(
            `[${id}] HINT: INVALID_ARGUMENT usually means one of:\n` +
              `         • SPEECH_LOCATION is wrong — must be us-central1, europe-west4, or asia-southeast1\n` +
              `         • chirp_2 model is not enabled in project "${PROJECT_ID}"\n` +
              `         • Speech-to-Text v2 API is not enabled — visit https://console.cloud.google.com/apis/library/speech.googleapis.com`,
          );
        }

        sendJson({
          type: "error",
          message: `Speech API error [${err.code}]: ${err.message}`,
        });
        // Null out the dead stream immediately — prevents hundreds of
        // ERR_STREAM_DESTROYED errors as audio chunks keep arriving.
        speechStream = null;
      }
    });

    stream.on("end", () => console.log(`[${id}] Speech stream ended`));

    // First write: recognizer path + streaming config
    stream.write({
      recognizer: RECOGNIZER_PATH,
      streamingConfig: STREAMING_CONFIG,
    });

    return stream;
  };

  // ── Proactive stream restart ──────────────────────────────────────────
  const scheduleRestart = (delayMs = 200) => {
    if (isRestarting) return;
    isRestarting = true;

    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }

    // Gracefully end old stream
    if (speechStream) {
      try {
        speechStream.end();
      } catch (_) {}
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
        try {
          speechStream.write({ audio: chunk });
        } catch (_) {}
      }

      // Schedule the next proactive restart
      restartTimer = setTimeout(() => scheduleRestart(), STREAM_RESTART_MS);
      isRestarting = false;
    }, delayMs);
  };

  // ── WebSocket message handler ─────────────────────────────────────────
  ws.on("message", (data, isBinary) => {
    // ── Control messages (JSON text) ────────────────────────────────────
    if (!isBinary) {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }

      if (msg.type === "start") {
        if (isRecording) return; // idempotent
        isRecording = true;
        audioBuffer = [];
        speechStream = openSpeechStream();
        restartTimer = setTimeout(() => scheduleRestart(), STREAM_RESTART_MS);
        sendJson({ type: "status", status: "recording" });
        console.log(`[${id}] Recording started`);
      } else if (msg.type === "stop") {
        isRecording = false;
        audioBuffer = [];
        if (restartTimer) {
          clearTimeout(restartTimer);
          restartTimer = null;
        }
        if (speechStream) {
          try {
            speechStream.end();
          } catch (_) {}
          speechStream = null;
        }
        sendJson({ type: "status", status: "stopped" });
        console.log(`[${id}] Recording stopped`);
      }
      return;
    }

    // ── Raw PCM audio (binary) ──────────────────────────────────────────
    if (!isRecording) return;

    if (isRestarting) {
      if (audioBuffer.length < MAX_BUFFER_CHUNKS_ON_RESTART) {
        audioBuffer.push(data); // keep streaming during restart
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
  ws.on("close", (code) => {
    console.log(`[${id}] Disconnected (${code})`);
    isRecording = false;
    if (restartTimer) clearTimeout(restartTimer);
    if (speechStream) {
      try {
        speechStream.end();
      } catch (_) {}
    }
  });

  ws.on("error", (err) => console.error(`[${id}] WS error: ${err.message}`));
});

// ── Graceful shutdown ──────────────────────────────────────────────────────
const shutdown = (signal) => {
  console.log(`[VoxLive] ${signal} — shutting down`);
  wss.clients.forEach((ws) => ws.close(1001, "Server shutting down"));
  server.close(() => {
    console.log("[VoxLive] Closed");
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000);
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ── Start ──────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`[VoxLive] Backend ready on :${PORT}`);
  console.log(`[VoxLive] GCP project : ${PROJECT_ID}`);
  console.log(`[VoxLive] Location    : ${LOCATION}`);
  console.log(`[VoxLive] Recognizer  : ${RECOGNIZER_PATH}`);
  console.log(`[VoxLive] Model       : chirp_3`);
  console.log(`[VoxLive] CORS origin : ${ALLOWED_ORIGIN.join(", ")}`);
});
