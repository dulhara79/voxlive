import { useState, useRef, useCallback, useEffect } from "react";

const WS_URL = import.meta.env.VITE_WS_URL || "ws://localhost:8080";
const MAX_RECONNECT = 5;
const RECONNECT_DELAY_MS = 2000;
const WS_CONNECT_TIMEOUT = 6000;

// Toggle verbose client logging with VITE_DEBUG="false".
const DEBUG = import.meta.env.VITE_DEBUG !== "false";
const ts = () => new Date().toISOString().slice(11, 23);
const dbg = (...a) => {
  if (DEBUG) console.log(`[${ts()}] [VoxLive]`, ...a);
};

// The ONLY languages we ever display.
const ALLOWED = new Set(["si-LK", "en-US", "ta-LK"]);

function normaliseLang(code) {
  if (!code) return null;
  const lower = code.toLowerCase();
  if (lower.startsWith("si")) return "si-LK";
  if (lower.startsWith("ta")) return "ta-LK";
  if (lower.startsWith("en")) return "en-US";
  // "auto" / unknown => dropped, not silently relabelled English.
  return null;
}

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

  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [diarizedSegments, setDiarizedSegments] = useState([]);
  const [wasDiarizationTruncated, setWasDiarizationTruncated] = useState(false);

  // Which backend path is live: "stream" (EN/TA real-time) or "microbatch"
  // (Sinhala/mixed, ~2s). Lets the UI show an honest latency notice.
  const [activePath, setActivePath] = useState(null);
  const [microbatchMs, setMicrobatchMs] = useState(2000);

  const wsRef = useRef(null);
  const audioCtxRef = useRef(null);
  const workletNodeRef = useRef(null);
  const micStreamRef = useRef(null);
  const reconnectCount = useRef(0);
  const reconnectTimer = useRef(null);
  const isRecordingRef = useRef(false);

  const modeRef = useRef("live");
  const languageCodesRef = useRef([]);
  const selectedSetRef = useRef(new Set()); // for the client-side filter

  const teardownAudio = useCallback(() => {
    dbg("Tearing down audio graph.");
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
      audioCtxRef.current.close().catch(() => { });
      audioCtxRef.current = null;
    }
  }, []);

  /** Hard client-side filter: allowed whitelist + selected subset. */
  const passesFilter = (normalized) => {
    if (!normalized || !ALLOWED.has(normalized)) return false;
    const sel = selectedSetRef.current;
    if (sel.size > 0) return sel.has(normalized);
    return true;
  };

  const openWebSocket = useCallback(() => {
    return new Promise((resolve, reject) => {
      dbg("Opening WebSocket:", WS_URL);
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error("Connection timed out. Is the backend running?"));
      }, WS_CONNECT_TIMEOUT);

      ws.onopen = () => {
        dbg("[SYSTEM] Pipeline connected.");
        clearTimeout(timeout);
        reconnectCount.current = 0;
        setIsConnecting(false);
        resolve(ws);
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);

          if (msg.type === "path") {
            dbg(`[PATH] Backend selected "${msg.path}" path.`, msg);
            setActivePath(msg.path);
            if (msg.microbatchMs) setMicrobatchMs(msg.microbatchMs);
            return;
          }

          if (msg.type === "error") {
            dbg("[ERROR]", msg.message);
            setError(msg.message || "Speech API error — check backend logs");
            setIsAnalyzing(false);
            return;
          }

          if (msg.type === "analyzing") {
            setIsAnalyzing(true);
            return;
          }

          if (msg.type === "diarized_transcript") {
            // Filter diarized segments to the allowed/selected languages too.
            const segs = (msg.segments || []).filter((s) => passesFilter(s.lang));
            dbg(`[DIARIZED] ${segs.length}/${(msg.segments || []).length} segment(s) kept after filter.`);
            setDiarizedSegments(segs);
            setWasDiarizationTruncated(msg.wasTruncated || false);
            setIsAnalyzing(false);
            if (msg.error) setError(msg.error);
            if (wsRef.current) {
              wsRef.current.close();
              wsRef.current = null;
            }
            return;
          }

          if (msg.type !== "transcription") return;

          const lang = normaliseLang(msg.languageCode);
          if (!passesFilter(lang)) {
            dbg(
              `[FILTER] dropped raw="${msg.languageCode}" normalized="${lang || "none"}"`,
            );
            setInterim({ text: "", lang: "en-US" });
            return;
          }

          if (msg.isFinal) {
            setInterim({ text: "", lang: "en-US" });
            if (!msg.transcript.trim()) return;
            dbg(`[FINAL] ${lang}: "${msg.transcript.trim().slice(0, 60)}"`);

            setSegments((prev) => [
              ...prev,
              {
                id: `${msg.timestamp}-${Math.random().toString(36).slice(2)}`,
                text: msg.transcript,
                lang,
                confidence: msg.confidence ?? 0,
              },
            ]);
            setLangStats((prev) => ({ ...prev, [lang]: (prev[lang] ?? 0) + 1 }));
          } else {
            setInterim({ text: msg.transcript, lang });
          }
        } catch (_) { }
      };

      ws.onerror = (e) => {
        console.error("[VoxLive] [CRITICAL] Socket exception:", e);
        clearTimeout(timeout);
        reject(
          new Error("WebSocket encountered a transport breakdown. Check configuration."),
        );
      };

      ws.onclose = (event) => {
        dbg("[SYSTEM] Socket closed.", { code: event.code });
        if (!isRecordingRef.current) return;
        if (reconnectCount.current >= MAX_RECONNECT) {
          setError("Lost connection. Please stop and try again.");
          setIsRecording(false);
          isRecordingRef.current = false;
          return;
        }
        reconnectCount.current++;
        dbg(`[RECONNECT] attempt ${reconnectCount.current}/${MAX_RECONNECT}`);
        reconnectTimer.current = setTimeout(() => {
          openWebSocket()
            .then((ws) =>
              ws.send(
                JSON.stringify({
                  type: "start",
                  mode: modeRef.current,
                  languageCodes: languageCodesRef.current,
                }),
              ),
            )
            .catch((e) => {
              setError(e.message);
              setIsRecording(false);
              isRecordingRef.current = false;
            });
        }, RECONNECT_DELAY_MS);
      };
    });
  }, []);

  const startRecording = useCallback(
    async (languageCodes, mode = "live") => {
      if (isRecordingRef.current) return;
      dbg("[START] requested", { languageCodes, mode });
      setError(null);
      setIsConnecting(true);
      setIsAnalyzing(false);
      setDiarizedSegments([]);
      setWasDiarizationTruncated(false);
      setActivePath(null);

      modeRef.current = mode;
      languageCodesRef.current = languageCodes;
      selectedSetRef.current = new Set(
        (languageCodes || []).filter((l) => ALLOWED.has(l)),
      );

      let localAudioCtx = null;
      let localMicStream = null;
      let localWorkletNode = null;

      try {
        const ws = await openWebSocket();

        localMicStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            channelCount: 1,
          },
          video: false,
        });
        micStreamRef.current = localMicStream;

        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        localAudioCtx = new AudioCtx({ sampleRate: 16000 });
        audioCtxRef.current = localAudioCtx;

        await localAudioCtx.audioWorklet.addModule("/audio-processor.js");
        if (localAudioCtx.state === "suspended") await localAudioCtx.resume();

        localWorkletNode = new AudioWorkletNode(localAudioCtx, "pcm-processor");
        workletNodeRef.current = localWorkletNode;

        const source = localAudioCtx.createMediaStreamSource(localMicStream);
        const silentGain = localAudioCtx.createGain();
        silentGain.gain.value = 0;
        source.connect(localWorkletNode);
        localWorkletNode.connect(silentGain);
        silentGain.connect(localAudioCtx.destination);

        const finalLangs = Array.isArray(languageCodes) ? languageCodes : [];
        ws.send(JSON.stringify({ type: "start", mode, languageCodes: finalLangs }));
        dbg("[START] sent start frame", { finalLangs, mode });

        localWorkletNode.port.onmessage = (e) => {
          if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(e.data);
          }
        };

        isRecordingRef.current = true;
        setIsRecording(true);
      } catch (e) {
        console.error("[VoxLive] Initialization error:", e);
        setIsConnecting(false);
        setError(e.message || "Failed to start live capture pipeline.");
        teardownAudio();
        if (wsRef.current) {
          wsRef.current.close();
          wsRef.current = null;
        }
      }
    },
    [openWebSocket, teardownAudio],
  );

  const stopRecording = useCallback(() => {
    dbg("[STOP] requested");
    isRecordingRef.current = false;
    setIsRecording(false);
    setInterim({ text: "", lang: "en-US" });

    if (reconnectTimer.current) {
      clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
    }
    if (wsRef.current) {
      try {
        wsRef.current.send(JSON.stringify({ type: "stop" }));
      } catch (_) { }
      if (modeRef.current === "live") {
        wsRef.current.close();
        wsRef.current = null;
      }
    }
    teardownAudio();
  }, [teardownAudio]);

  const clearTranscript = useCallback(() => {
    dbg("[CLEAR] transcript");
    setSegments([]);
    setDiarizedSegments([]);
    setInterim({ text: "", lang: "en-US" });
    setLangStats({ "en-US": 0, "si-LK": 0, "ta-LK": 0 });
    setWasDiarizationTruncated(false);
  }, []);

  useEffect(
    () => () => {
      if (isRecordingRef.current) stopRecording();
    },
    [stopRecording],
  );

  return {
    isRecording,
    isConnecting,
    isAnalyzing,
    segments,
    interim,
    langStats,
    diarizedSegments,
    wasDiarizationTruncated,
    activePath,
    microbatchMs,
    error,
    startRecording,
    stopRecording,
    clearTranscript,
  };
}