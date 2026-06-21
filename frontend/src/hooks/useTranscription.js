import { useState, useRef, useCallback, useEffect } from "react";

const WS_URL = import.meta.env.VITE_WS_URL || "ws://localhost:8080";
const MAX_RECONNECT = 5;
const RECONNECT_DELAY_MS = 2000;
const WS_CONNECT_TIMEOUT = 6000;

/**
 * Normalise a BCP-47 language code returned by Chirp into the three canonical
 * codes used by the UI: 'en-US', 'si-LK', 'ta-LK'.
 */
function normaliseLang(code) {
  if (!code) return "en-US";
  const lower = code.toLowerCase();
  if (lower.startsWith("si")) return "si-LK";
  if (lower.startsWith("ta")) return "ta-LK";
  return "en-US";
}

/**
 * useTranscription
 *
 * Manages the full lifecycle of:
 *   Mic → AudioContext (16kHz) → AudioWorklet (Float32→Int16)
 *     → WebSocket → Google Chirp backend
 *
 * All mutable handles live in refs so WebSocket callbacks never capture
 * stale closure values.
 */
export function useTranscription() {
  const [isRecording, setIsRecording] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [segments, setSegments] = useState([]);
  const [interim, setInterim] = useState({ text: "", lang: "en-US" });
  const [langStats, setLangStats] = useState({
    "en-US": 0,
    "si-LK": 0,
    "ta-LK": 0,
  });
  const [error, setError] = useState(null);

  // Mutable refs — safe to access inside callbacks without stale-closure issues
  const wsRef = useRef(null);
  const audioCtxRef = useRef(null);
  const workletNodeRef = useRef(null);
  const micStreamRef = useRef(null);
  const reconnectCount = useRef(0);
  const reconnectTimer = useRef(null);
  const isRecordingRef = useRef(false); // mirrors isRecording state for callbacks

  // ── Helpers ──────────────────────────────────────────────────────────────
  const teardownAudio = useCallback(() => {
    if (workletNodeRef.current) {
      workletNodeRef.current.port.onmessage = null;
      workletNodeRef.current.disconnect();
      workletNodeRef.current = null;
    }
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
  }, []);

  // ── WebSocket connection ──────────────────────────────────────────────────
  const openWebSocket = useCallback(() => {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error("Connection timed out. Is the backend running?"));
      }, WS_CONNECT_TIMEOUT);

      ws.onopen = () => {
        console.log("[VoxLive] WebSocket connection established successfully.");
        clearTimeout(timeout);
        reconnectCount.current = 0;
        setIsConnecting(false);
        resolve(ws);
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);

          // Surface backend errors in the UI
          if (msg.type === "error") {
            console.error("[VoxLive] Backend reported error:", msg.message);
            setError(msg.message || "Speech API error — check backend logs");
            return;
          }

          if (msg.type !== "transcription") return;

          const lang = normaliseLang(msg.languageCode);
          console.log(`[VoxLive] Transcription received (isFinal=${msg.isFinal}): "${msg.transcript}" [lang=${lang}]`);



          if (msg.isFinal) {
            setInterim({ text: "", lang: "en-US" });
            setSegments((prev) => [
              ...prev,
              {
                id: `${msg.timestamp}-${Math.random().toString(36).slice(2)}`,
                text: msg.transcript,
                lang,
                confidence: msg.confidence ?? 0,
              },
            ]);
            setLangStats((prev) => ({
              ...prev,
              [lang]: (prev[lang] ?? 0) + 1,
            }));
          } else {
            setInterim({ text: msg.transcript, lang });
          }
        } catch (_) {
          /* ignore malformed frames */
        }
      };

      ws.onerror = (err) => {
        console.error("[VoxLive] WebSocket error event:", err);
        clearTimeout(timeout);
        reject(
          new Error("WebSocket error — check backend URL and CORS settings"),
        );
      };

      ws.onclose = (event) => {
        console.log(`[VoxLive] WebSocket closed. Code: ${event.code}, Reason: ${event.reason || "None"}`);
        // Auto-reconnect only while we should still be recording
        if (!isRecordingRef.current) return;
        if (reconnectCount.current >= MAX_RECONNECT) {
          setError("Lost connection. Please stop and try again.");
          setIsRecording(false);
          isRecordingRef.current = false;
          return;
        }
        reconnectCount.current++;
        console.log(
          `[VoxLive] Reconnecting (${reconnectCount.current}/${MAX_RECONNECT})…`,
        );
        reconnectTimer.current = setTimeout(() => {
          openWebSocket()
            .then((ws) => ws.send(JSON.stringify({ type: "start" })))
            .catch((err) => {
              setError(err.message);
              setIsRecording(false);
              isRecordingRef.current = false;
            });
        }, RECONNECT_DELAY_MS);
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // intentionally empty — openWebSocket references itself via closure for reconnect

  // ── Start ─────────────────────────────────────────────────────────────────
  const startRecording = useCallback(async (languageCode) => {
    if (isRecordingRef.current) return;
    console.log("[VoxLive] Starting recording lifecycle...");
    setError(null);
    setIsConnecting(true);

    try {
      // 1 — Mic permission
      console.log("[VoxLive] Requesting microphone access...");
      const micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          channelCount: 1,
        },
        video: false,
      });
      micStreamRef.current = micStream;

      // 2 — AudioContext at 16 kHz (browser resamples from device native rate)
      console.log("[VoxLive] Initializing AudioContext at 16000Hz...");
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      const audioCtx = new AudioCtx({ sampleRate: 16000 });
      if (audioCtx.state === "suspended") {
        console.log("[VoxLive] AudioContext state is suspended. Resuming...");
        await audioCtx.resume();
      }
      audioCtxRef.current = audioCtx;

      // 3 — AudioWorklet
      console.log("[VoxLive] Adding AudioWorklet module '/audio-processor.js'...");
      await audioCtx.audioWorklet.addModule("/audio-processor.js");
      const workletNode = new AudioWorkletNode(audioCtx, "pcm-processor");
      workletNodeRef.current = workletNode;

      // Connect: mic source → worklet → silent gain (keeps worklet alive without playback)
      const source = audioCtx.createMediaStreamSource(micStream);
      const silentGain = audioCtx.createGain();
      silentGain.gain.value = 0;
      source.connect(workletNode);
      workletNode.connect(silentGain);
      silentGain.connect(audioCtx.destination);

      // 4 — WebSocket
      console.log("[VoxLive] Opening WebSocket connection...");
      const ws = await openWebSocket();
      const finalLang = typeof languageCode === "string" ? languageCode : null;
      console.log(`[VoxLive] Sending 'start' control message to backend with languageCode: ${finalLang || "auto"}...`);
      ws.send(JSON.stringify({ type: "start", languageCode: finalLang }));

      // 5 — Pipe PCM chunks → WebSocket (ArrayBuffer, sent as binary frame)
      let chunkCount = 0;
      workletNode.port.onmessage = (e) => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          chunkCount++;
          if (chunkCount % 30 === 0) {
            console.log(`[VoxLive] Audio flow: piped ${chunkCount} chunks to WebSocket`);
          }
          wsRef.current.send(e.data);
        }
      };

      console.log("[VoxLive] Recording active and streaming.");
      isRecordingRef.current = true;
      setIsRecording(true);
    } catch (err) {
      console.error("[VoxLive] Error during startRecording:", err);
      setIsConnecting(false);
      setError(err.message || "Failed to start recording");
      teardownAudio();
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    }
  }, [openWebSocket, teardownAudio]);

  // ── Stop ──────────────────────────────────────────────────────────────────
  const stopRecording = useCallback(() => {
    console.log("[VoxLive] Stopping recording lifecycle...");
    isRecordingRef.current = false;
    setIsRecording(false);
    setInterim({ text: "", lang: "en-US" });

    if (reconnectTimer.current) {
      clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
    }

    if (wsRef.current) {
      try {
        console.log("[VoxLive] Sending 'stop' control message to backend...");
        wsRef.current.send(JSON.stringify({ type: "stop" }));
      } catch (_) {}
      console.log("[VoxLive] Closing WebSocket...");
      wsRef.current.close();
      wsRef.current = null;
    }

    teardownAudio();
    console.log("[VoxLive] Audio and WebSocket teardown completed.");
  }, [teardownAudio]);

  // ── Clear ─────────────────────────────────────────────────────────────────
  const clearTranscript = useCallback(() => {
    setSegments([]);
    setInterim({ text: "", lang: "en-US" });
    setLangStats({ "en-US": 0, "si-LK": 0, "ta-LK": 0 });
  }, []);

  // ── Cleanup on unmount ────────────────────────────────────────────────────
  useEffect(
    () => () => {
      if (isRecordingRef.current) stopRecording();
    },
    [stopRecording],
  );

  return {
    isRecording,
    isConnecting,
    segments,
    interim,
    langStats,
    error,
    startRecording,
    stopRecording,
    clearTranscript,
  };
}
