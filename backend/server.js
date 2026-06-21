"use strict";
require("dotenv").config();

const http = require("http");
const express = require("express");
const cors = require("cors");
const WebSocket = require("ws");
const speech = require("@google-cloud/speech");

// ── Config ─────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || "8080", 10);

// Prefer numeric project NUMBER over string project ID.
// Speech-to-Text v2 sometimes rejects string IDs in the recognizer resource path.
// Get your project number: GCP Console → Home → Project Info card → "Project number"
const PROJECT_ID =
  process.env.GOOGLE_CLOUD_PROJECT_NUMBER || process.env.GOOGLE_CLOUD_PROJECT;

const ALLOWED_ORIGIN = (process.env.ALLOWED_ORIGIN || "http://localhost:5173")
  .split(",")
  .map((s) => s.trim());

const STREAM_RESTART_MS = 4 * 60 * 1000; // restart before Google's 5-min hard limit
const MAX_BUFFER_CHUNKS_ON_RESTART = 80; // ~20 s of audio buffered during restart

if (!PROJECT_ID) {
  console.error("[VoxLive] GOOGLE_CLOUD_PROJECT is required");
  process.exit(1);
}

// ── Model & location — THESE TWO ARE TIGHTLY COUPLED ──────────────────────
//
//  Speech-to-Text v2 recognizer paths embed the location:
//    projects/{project}/locations/{location}/recognizers/_
//
//  The location value must match what the model supports:
//
//  ┌──────────────────────┬──────────────────────────────────────────────────┐
//  │ Model                │ Required location(s)                              │
//  ├──────────────────────┼──────────────────────────────────────────────────┤
//  │ latest_long          │ global   ← ONLY "global" is valid                │
//  │ long / short         │ global                                            │
//  │ chirp_2              │ us-central1 / europe-west4 / asia-southeast1     │
//  │ chirp                │ (batch only — do NOT use with streamingRecognize) │
//  └──────────────────────┴──────────────────────────────────────────────────┘
//
//  Using a regional location (e.g. us-central1) with a standard model such
//  as latest_long produces exactly:
//    INVALID_ARGUMENT: Invalid resource field value in the request.
//
//  Using "global" with a Chirp model also produces INVALID_ARGUMENT.
//
//  The code below resolves the correct location automatically from the model.
//
const SPEECH_MODEL = process.env.SPEECH_MODEL || "chirp_2";

const IS_CHIRP = SPEECH_MODEL.startsWith("chirp");

// Chirp-capable regional locations (including multi-regions like 'us' and 'eu')
const CHIRP_REGIONS = new Set([
  "us",
  "eu",
  "us-central1",
  "europe-west4",
  "asia-southeast1",
]);

// Resolve SPEECH_LOCATION — auto-correct and warn if it conflicts with the model
const _envLocation = process.env.SPEECH_LOCATION || "";
let LOCATION;

if (IS_CHIRP) {
  LOCATION = CHIRP_REGIONS.has(_envLocation) ? _envLocation : "us-central1";
  if (_envLocation && !CHIRP_REGIONS.has(_envLocation)) {
    console.warn(
      `[VoxLive] WARN: SPEECH_LOCATION="${_envLocation}" is not valid for ${SPEECH_MODEL}.\n` +
        `         Auto-correcting to "${LOCATION}".\n` +
        `         Valid Chirp locations: ${[...CHIRP_REGIONS].join(", ")}`,
    );
  }
} else {
  // Standard models (latest_long, long, short…) MUST use "global"
  LOCATION = "global";
  if (_envLocation && _envLocation !== "global") {
    console.warn(
      `[VoxLive] WARN: SPEECH_LOCATION="${_envLocation}" is not valid for model "${SPEECH_MODEL}".\n` +
        `         Standard models require location="global". Auto-correcting.`,
    );
  }
}

// ── Audio decoding config ───────────────────────────────────────────────────
//
//  • Chirp streaming: use autoDecodingConfig: {}
//    explicitDecodingConfig causes INVALID_ARGUMENT with Chirp streaming.
//
//  • Standard models (latest_long etc): use explicitDecodingConfig with LINEAR16.
//    The frontend sends raw Int16 PCM at 16 kHz with no WAV header.
//    autoDecodingConfig: {} can't detect raw PCM without a container header,
//    which may also contribute to INVALID_ARGUMENT on standard model streams.
//
const audioConfig = {
  explicitDecodingConfig: {
    encoding: "LINEAR16",
    sampleRateHertz: 16000,
    audioChannelCount: 1,
  },
};

// ── Language codes ─────────────────────────────────────────────────────────
//
//  For Chirp 2, we must use ["auto"] to enable automatic language detection
//  and code-switching. Specifying multiple language codes in the array (e.g.
//  ["si-LK", "ta-IN", "en-US"]) is rejected by the v2 streaming API with
//  INVALID_ARGUMENT: Invalid arguments were provided.
//  Standard models support only a single language — use en-US as baseline.
//
const languageCodes = IS_CHIRP ? ["auto"] : ["en-US"];

// ── Speech client ──────────────────────────────────────────────────────────
//
//  For regional locations (like us-central1), we must use the region-specific
//  endpoint (e.g. us-central1-speech.googleapis.com). For the global location,
//  we use speech.googleapis.com.
//
const speechClients = {};
function getSpeechClient(location) {
  if (speechClients[location]) return speechClients[location];
  const endpoint = location === "global" ? "speech.googleapis.com" : `${location}-speech.googleapis.com`;
  speechClients[location] = new speech.v2.SpeechClient({
    apiEndpoint: endpoint,
    // Configure gRPC keepalives to prevent silent socket resets and idle connection dropouts
    "grpc.keepalive_time_ms": 20000,           // Send PING every 20 seconds
    "grpc.keepalive_timeout_ms": 10000,        // Wait 10 seconds for PING ACK
    "grpc.keepalive_permit_without_calls": 1,  // Allow keepalives when no active calls exist
    "grpc.http2.min_time_between_pings_ms": 10000,
  });
  return speechClients[location];
}

const speechClient = getSpeechClient(LOCATION);

const RECOGNIZER_PATH = `projects/${PROJECT_ID}/locations/${LOCATION}/recognizers/_`;

const STREAMING_CONFIG = {
  config: {
    ...audioConfig,
    languageCodes,
    model: SPEECH_MODEL,
    features: {
      enableAutomaticPunctuation: true,
    },
  },
  streamingFeatures: {
    interimResults: true,
  },
};

// ── GCP startup verification ────────────────────────────────────────────────
//
//  Calls listRecognizers at startup to catch API/IAM issues before the first
//  WebSocket client connects. Failures print an actionable error but do NOT
//  exit — the server still starts so you can see the log in context.
//
async function verifyGcpSetup() {
  try {
    const parent = `projects/${PROJECT_ID}/locations/${LOCATION}`;
    const [recognizers] = await speechClient.listRecognizers({ parent });
    console.log(
      `[VoxLive] GCP OK — Speech-to-Text v2 API is reachable.\n` +
        `[VoxLive]          ${recognizers.length} named recognizer(s) in project.`,
    );
  } catch (err) {
    console.error(
      `[VoxLive] ⚠  GCP verification failed [${err.code}]: ${err.message}`,
    );
    if (err.code === 5)
      console.error(
        `[VoxLive]    → NOT_FOUND: API not enabled or wrong project ID.\n           Enable: https://console.cloud.google.com/apis/library/speech.googleapis.com?project=${PROJECT_ID}`,
      );
    if (err.code === 7)
      console.error(
        `[VoxLive]    → PERMISSION_DENIED: Service account needs roles/speech.client.\n           IAM: https://console.cloud.google.com/iam-admin/iam?project=${PROJECT_ID}`,
      );
    if (err.code === 16)
      console.error(
        `[VoxLive]    → UNAUTHENTICATED: Key file is missing, expired, or wrong project.`,
      );
    if (err.code === 3)
      console.error(
        `[VoxLive]    → INVALID_ARGUMENT: Try setting GOOGLE_CLOUD_PROJECT_NUMBER=<numeric_id> in .env`,
      );
  }
}

// ── HTTP / WS server ───────────────────────────────────────────────────────
const app = express();
app.use(cors({ origin: ALLOWED_ORIGIN, credentials: true }));
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    connections: wss.clients.size,
    model: SPEECH_MODEL,
    location: LOCATION,
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
  let audioBuffer = [];
  let activeLanguageCode = null;

  const sendJson = (obj) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  };

  // ── Speech stream factory ─────────────────────────────────────────────
  const openSpeechStream = (langCode) => {
    // Determine the target model and location dynamically.
    // chirp_3 does NOT support Sinhala (si-LK), so we must use chirp_2 for Sinhala or Auto-detect.
    let activeModel = SPEECH_MODEL;
    let activeLocation = LOCATION;

    const isSinhalaOrAuto = langCode === "si-LK" || (!langCode && languageCodes.includes("auto"));
    if (isSinhalaOrAuto && SPEECH_MODEL === "chirp_3") {
      console.log(`[${id}] Sinhala/Auto requested but chirp_3 does not support Sinhala. Dynamically falling back to chirp_2 on us-central1.`);
      activeModel = "chirp_2";
      activeLocation = "us-central1";
    }

    const activeClient = getSpeechClient(activeLocation);
    const activeRecognizer = `projects/${PROJECT_ID}/locations/${activeLocation}/recognizers/_`;

    const stream = activeClient._streamingRecognize();

    stream.on("data", (response) => {
      if (!response.results?.length) return;
      const result = response.results[0];
      if (!result.alternatives?.length) return;

      const alt = result.alternatives[0];
      const isFinal = result.isFinal ?? false;
      const langCode = result.languageCode || "en-US";
      const confidence = isFinal ? (alt.confidence ?? 0) : 0;
      const stability = isFinal ? 0 : (result.stability ?? 0);

      console.log(`[${id}] API Response -> "${alt.transcript}" (final=${isFinal}, lang=${langCode}, confidence=${confidence.toFixed(2)})`);

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
      // Re-establish stream on Google limits (4, 11) or transient connection drops (10, 14)
      const isTransientOrLimitErr =
        err.code === 11 || // OUT_OF_RANGE
        err.code === 4 ||  // DEADLINE_EXCEEDED
        err.code === 10 || // ABORTED (timeout)
        err.code === 14 || // UNAVAILABLE (e.g. ECONNRESET)
        (err.message || "").toLowerCase().includes("exceeded maximum") ||
        (err.message || "").toLowerCase().includes("timeout") ||
        (err.message || "").toLowerCase().includes("connreset");

      if (isTransientOrLimitErr) {
        console.warn(`[${id}] Speech stream transient/limit error [code ${err.code}] — restarting stream...`);
        scheduleRestart(100);
        return;
      }

      console.error(`[${id}] Speech error [${err.code}]: ${err.message}`, err);

      if (err.code === 3) {
        console.error(
          `[${id}] INVALID_ARGUMENT diagnostic:\n` +
            `         Recognizer : ${activeRecognizer}\n` +
            `         Model      : ${activeModel}\n` +
            `         Location   : ${activeLocation}\n` +
            `         Audio cfg  : explicitDecodingConfig LINEAR16/16000/1ch\n` +
            `         Remaining causes to check:\n` +
            `           1. Project identifier — try GOOGLE_CLOUD_PROJECT_NUMBER=<numeric_id> in .env\n` +
            `              Get it: GCP Console → Home → Project Info → Project number\n` +
            `           2. Speech-to-Text v2 API not enabled:\n` +
            `              https://console.cloud.google.com/apis/library/speech.googleapis.com?project=${PROJECT_ID}\n` +
            `           3. For chirp_2: ensure Chirp 2 access is granted in your GCP project\n` +
            `              https://console.cloud.google.com/speech`,
        );
      }

      sendJson({
        type: "error",
        message: `Speech API error [${err.code}]: ${err.message}`,
      });
      speechStream = null;
    });

    stream.on("end", () => console.log(`[${id}] Speech stream ended`));

    // Construct dynamic streaming config, overriding language codes if requested
    const resolvedLangCode = langCode === "ta-LK" ? "ta-IN" : langCode;
    const currentLanguageCodes = resolvedLangCode ? [resolvedLangCode] : languageCodes;
    const config = {
      ...STREAMING_CONFIG,
      config: {
        ...STREAMING_CONFIG.config,
        languageCodes: currentLanguageCodes,
        model: activeModel,
      },
    };

    console.log(`[${id}] Initializing Google stream with:`, JSON.stringify({
      recognizer: activeRecognizer,
      streamingConfig: config,
    }, null, 2));

    stream.write({
      recognizer: activeRecognizer,
      streamingConfig: config,
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
      speechStream = openSpeechStream(activeLanguageCode);
      console.log(`[${id}] Speech stream restarted`);

      const pending = audioBuffer.splice(0);
      for (const chunk of pending) {
        try {
          speechStream.write({ audio: chunk });
        } catch (_) {}
      }

      restartTimer = setTimeout(() => scheduleRestart(), STREAM_RESTART_MS);
      isRestarting = false;
    }, delayMs);
  };

  // ── WebSocket message handler ─────────────────────────────────────────
  ws.on("message", (data, isBinary) => {
    if (!isBinary) {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }

      if (msg.type === "start") {
        if (isRecording) return;
        isRecording = true;
        audioBuffer = [];
        activeLanguageCode = msg.languageCode || null;
        speechStream = openSpeechStream(activeLanguageCode);
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

    if (!isRecording) return;
    if (isRestarting) {
      if (audioBuffer.length < MAX_BUFFER_CHUNKS_ON_RESTART)
        audioBuffer.push(data);
      return;
    }
    if (speechStream) {
      try {
        if (typeof ws.chunkCount === "undefined") ws.chunkCount = 0;
        ws.chunkCount++;
        if (ws.chunkCount % 30 === 0) {
          let maxAmp = 0;
          const sampleCount = data.length / 2;
          for (let i = 0; i < sampleCount; i++) {
            const val = data.readInt16LE(i * 2);
            const abs = Math.abs(val);
            if (abs > maxAmp) maxAmp = abs;
          }
          console.log(`[${id}] Audio streaming: sent ${ws.chunkCount} chunks (~15s) of size ${data.length} bytes | max amplitude: ${maxAmp}`);
        }
        speechStream.write({ audio: data });
      } catch (err) {
        console.error(`[${id}] Write error: ${err.message}`);
      }
    }
  });

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
server.listen(PORT, async () => {
  console.log(`[VoxLive] Backend ready on       : ${PORT}`);
  console.log(`[VoxLive] GCP project             : ${PROJECT_ID}`);
  console.log(`[VoxLive] Location (resolved)     : ${LOCATION}`);
  console.log(`[VoxLive] Recognizer path         : ${RECOGNIZER_PATH}`);
  console.log(`[VoxLive] Model                   : ${SPEECH_MODEL}`);
  console.log(
    `[VoxLive] Audio config             : explicitDecodingConfig LINEAR16/16kHz/mono`,
  );
  console.log(
    `[VoxLive] Language codes           : ${languageCodes.join(", ")}`,
  );
  const startupEndpoint = LOCATION === "global" ? "speech.googleapis.com" : `${LOCATION}-speech.googleapis.com`;
  console.log(`[VoxLive] API endpoint (resolved) : ${startupEndpoint}`);
  console.log(
    `[VoxLive] CORS origin              : ${ALLOWED_ORIGIN.join(", ")}`,
  );

  // Verify GCP connectivity at startup
  await verifyGcpSetup();
});
