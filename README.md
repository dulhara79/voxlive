# VoxLive — Real-time Multilingual Transcription

Live speech-to-text for **Sinhala · English · Tamil** (and mixed code-switching),  
powered by [Google Chirp](https://cloud.google.com/speech-to-text/v2/docs/chirp-model) (Speech-to-Text v2).

```
Browser mic → AudioWorklet (Float32→Int16) → WebSocket → Node.js backend → Google Chirp
```

---

## Features

- **Automatic language detection** — speak in any of the three languages; Chirp identifies each utterance automatically
- **Code-switching support** — mixed phrases like *"Okay, meeting eka schedule කරමු"* are transcribed accurately
- **Interim results** — words appear as you speak, finals lock in with confidence scores
- **Per-language usage stats** — live percentage bars for EN / SI / TA
- **Stream auto-restart** — backend proactively restarts the Chirp stream every 4 min (before Google's 5-min hard limit), with audio buffering so not a single word is dropped
- **Auto-reconnect** — frontend reconnects the WebSocket up to 5 times on disconnection
- **Dark mode** — follows system preference
- **Production-ready** — Docker + Nginx, graceful shutdown, health endpoint, non-root container user

---

## Prerequisites

| Requirement | Version |
|---|---|
| Node.js | ≥ 18 |
| npm | ≥ 9 |
| Docker + Compose | (for production) |
| Google Cloud project | with **Speech-to-Text API** enabled |

---

## Google Cloud Setup

### 1 — Enable the API

```bash
gcloud services enable speech.googleapis.com --project=YOUR_PROJECT_ID
```

### 2 — Create a service account

```bash
# Create account
gcloud iam service-accounts create voxlive-speech \
  --display-name="VoxLive Speech" \
  --project=YOUR_PROJECT_ID

# Grant the Cloud Speech Client role
gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member="serviceAccount:voxlive-speech@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/speech.client"

# Download key (local dev only — never commit this file)
gcloud iam service-accounts keys create gcp-key.json \
  --iam-account=voxlive-speech@YOUR_PROJECT_ID.iam.gserviceaccount.com
```

### 3 — Chirp model availability

| Region | Latency from Sri Lanka |
|---|---|
| `us-central1` | ~220 ms RTT |
| `asia-southeast1` | ~80 ms RTT ← **recommended** |

Change `SPEECH_LOCATION` in `.env` to switch regions.  
If your project has access to **Chirp 2**, edit `model: 'chirp'` → `model: 'chirp_2'` in `backend/server.js` for better code-switching accuracy.

---

## Development Setup

### Backend

```bash
cd backend
cp .env.example .env
# Edit .env — fill in GOOGLE_CLOUD_PROJECT and GOOGLE_APPLICATION_CREDENTIALS
npm install
npm run dev
```

The backend starts on **http://localhost:8080**.  
Health check: `curl http://localhost:8080/health`

### Frontend

```bash
cd frontend
cp .env.example .env
# Default VITE_WS_URL=ws://localhost:8080 is fine for local dev
npm install
npm run dev
```

The app opens at **http://localhost:5173**.

> **Note:** The browser must have microphone permission and must be served over `localhost` or `HTTPS`. Plain `http://` on a remote host will be blocked by the browser's secure-context requirement for `getUserMedia`.

---

## Production Deployment (Docker)

```bash
# Copy and configure the root-level .env
cp backend/.env.example .env
# Set: GOOGLE_CLOUD_PROJECT, GCP_KEY_FILE, VITE_WS_URL, ALLOWED_ORIGIN

docker compose up --build -d
```

| Service | Port | URL |
|---|---|---|
| Frontend (Nginx) | 5173 | http://your-server:5173 |
| Backend (Node.js) | 8080 | http://your-server:8080 |

### Cloud Run (serverless)

```bash
# Backend
gcloud run deploy voxlive-backend \
  --source ./backend \
  --platform managed \
  --region asia-southeast1 \
  --set-env-vars GOOGLE_CLOUD_PROJECT=YOUR_PROJECT_ID,SPEECH_LOCATION=asia-southeast1 \
  --allow-unauthenticated

# Frontend (set VITE_WS_URL to the Cloud Run backend URL before building)
VITE_WS_URL=wss://voxlive-backend-xxxx.run.app npm run build --prefix frontend
# Then deploy the dist/ folder to Firebase Hosting, Cloud Storage, or any CDN
```

> On Cloud Run, remove `GOOGLE_APPLICATION_CREDENTIALS` — Workload Identity is automatic.

---

## Configuration Reference

### `backend/.env`

| Variable | Required | Default | Description |
|---|---|---|---|
| `GOOGLE_CLOUD_PROJECT` | ✅ | — | GCP project ID |
| `GOOGLE_APPLICATION_CREDENTIALS` | local only | — | Path to service account JSON |
| `SPEECH_LOCATION` | | `us-central1` | Chirp API region |
| `PORT` | | `8080` | HTTP/WS port |
| `ALLOWED_ORIGIN` | | `http://localhost:5173` | CORS origin(s), comma-separated |

### `frontend/.env`

| Variable | Required | Default | Description |
|---|---|---|---|
| `VITE_WS_URL` | | `ws://localhost:8080` | Backend WebSocket URL. Use `wss://` for HTTPS. |

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  Browser                                                 │
│                                                          │
│  Mic → AudioContext(16kHz) → AudioWorklet               │
│        (Float32 samples → Int16 PCM, 256ms chunks)      │
│               │                                          │
│               │  Binary WebSocket frames                 │
│               ▼                                          │
│  useTranscription hook                                   │
│  · Reconnect logic (max 5 attempts)                      │
│  · Segment / interim / langStats state                   │
└─────────────────────────┬────────────────────────────────┘
                          │ ws://  (dev)
                          │ wss:// (prod)
┌─────────────────────────▼────────────────────────────────┐
│  Node.js backend  (Express + ws)                         │
│                                                          │
│  Per-connection speech stream:                           │
│  · Proactive restart at 4 min                            │
│  · Audio buffering during restart                        │
│  · SIGTERM graceful shutdown                             │
│               │                                          │
│               │  gRPC streaming                          │
│               ▼                                          │
│  Google Chirp (Speech-to-Text v2)                        │
│  languageCodes: si-LK, ta-LK, ta-IN, en-US, en-IN       │
│  model: chirp  (or chirp_2 for better code-switching)    │
└──────────────────────────────────────────────────────────┘
```

---

## WebSocket Protocol

| Direction | Type | Payload |
|---|---|---|
| Client → Server | text | `{"type":"start"}` |
| Client → Server | text | `{"type":"stop"}` |
| Client → Server | binary | Raw Int16 LINEAR16 PCM at 16 kHz |
| Server → Client | text | `{"type":"transcription","transcript":"...","isFinal":true,"languageCode":"si-LK","confidence":0.94,"stability":0,"timestamp":1234567890}` |
| Server → Client | text | `{"type":"status","status":"recording"/"stopped"}` |
| Server → Client | text | `{"type":"error","message":"..."}` |

---

## Supported Languages

| Code | Language | Script |
|---|---|---|
| `si-LK` | Sinhala (Sri Lanka) | සිංහල |
| `ta-LK` | Tamil (Sri Lanka) | தமிழ் |
| `ta-IN` | Tamil (India) | தமிழ் |
| `en-US` | English (US) | Latin |
| `en-IN` | English (India) | Latin |

Chirp returns the detected `languageCode` per result. The frontend normalises `ta-IN` → `ta-LK` for display.

---

## Troubleshooting

**"WebSocket connection failed"**  
→ Confirm the backend is running and `VITE_WS_URL` matches.  
→ On HTTPS frontends, `VITE_WS_URL` must be `wss://`, not `ws://`.

**No transcription returned**  
→ Check the backend console for `[Speech error]` messages.  
→ Verify `GOOGLE_CLOUD_PROJECT` is correct and the Speech API is enabled.  
→ Confirm the service account has `roles/speech.client`.

**Chirp not available in region**  
→ Try `SPEECH_LOCATION=us-central1`.

**AudioWorklet not loading**  
→ The file `public/audio-processor.js` must be served from the same origin.  
→ Some browsers block AudioWorklet on plain `http://` (non-localhost). Use `localhost` in dev or HTTPS in prod.

---

## Licence

MIT
