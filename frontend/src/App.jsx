import { useState, useRef, useEffect } from 'react';
import { useTranscription } from './hooks/useTranscription';

// ── Language metadata ──────────────────────────────────────────────────────
const LANGS = {
  'en-US': { label: 'English', native: 'English', short: 'EN', key: 'en' },
  'si-LK': { label: 'Sinhala', native: 'සිංහල', short: 'SI', key: 'si' },
  'ta-LK': { label: 'Tamil', native: 'தமிழ்', short: 'TA', key: 'ta' },
};
const LANG_ORDER = ['en-US', 'si-LK', 'ta-LK'];

// ── Sub-components ─────────────────────────────────────────────────────────
function LangBadge({ lang }) {
  const m = LANGS[lang] ?? LANGS['en-US'];
  return <span className={`badge badge--${m.key}`}>{m.short}</span>;
}

function LangCard({ lang, isActive, onClick, disabled }) {
  const m = LANGS[lang];
  return (
    <div
      className={`card card--${m.key}${isActive ? ' card--active' : ''}${disabled ? ' card--disabled' : ''}`}
      onClick={disabled ? undefined : onClick}
      style={{ cursor: disabled ? 'not-allowed' : 'pointer' }}
      role="button"
      tabIndex={disabled ? -1 : 0}
      onKeyDown={(e) => {
        if (!disabled && onClick && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onClick();
        }
      }}
    >
      <div className="card__native">{m.native}</div>
      <div className="card__label">{m.label}</div>
    </div>
  );
}

function LatencyGuide({ hasSelection }) {
  // Keeping this commented out as in your file
  return null;
}

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" width="28" height="28">
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" width="26" height="26">
      <rect x="5" y="5" width="14" height="14" rx="2" />
    </svg>
  );
}

// ── Main app ───────────────────────────────────────────────────────────────
export default function App() {
  const [selectedLangs, setSelectedLangs] = useState([]);
  const [mode, setMode] = useState('live'); // 'live' or 'speaker'
  const {
    isRecording, isConnecting, isAnalyzing,
    segments, interim, langStats,
    diarizedSegments, wasDiarizationTruncated,
    error,
    startRecording, stopRecording, clearTranscript,
  } = useTranscription();

  const bottomRef = useRef(null);

  // Auto-scroll transcript to latest entry
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [segments.length, interim.text, diarizedSegments.length, isAnalyzing]);

  // Active language = most-recent final segment, or current interim
  const activeLang = segments.length > 0
    ? segments[segments.length - 1].lang
    : interim.text
      ? interim.lang
      : null;

  const handleLangToggle = (lang) => {
    setSelectedLangs(prev => {
      if (prev.includes(lang)) {
        return prev.filter(l => l !== lang);
      } else {
        return [...prev, lang];
      }
    });
  };

  const downloadTranscript = () => {
    let content = "";
    const dateStr = new Date().toLocaleDateString();

    if (mode === "speaker") {
      content = `VoxLive Speaker Separation Transcript - ${dateStr}\n\n`;
      if (diarizedSegments.length === 0) {
        content += "(No speaker segments transcribed)\n";
      } else {
        diarizedSegments.forEach((seg) => {
          const langLabel = LANGS[seg.lang]?.label || seg.lang;
          content += `${seg.speaker}: "${seg.text}" (${langLabel})\n\n`;
        });
      }
    } else {
      content = `VoxLive Transcription Transcript - ${dateStr}\n\n`;
      if (segments.length === 0) {
        content += "(No text transcribed)\n";
      } else {
        segments.forEach((seg) => {
          const langLabel = LANGS[seg.lang]?.label || seg.lang;
          content += `[${langLabel}] ${seg.text}\n`;
        });
      }
    }

    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `VoxLive_Transcript_${mode}_${new Date().toISOString().slice(0, 10)}.txt`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const targetLangsLabel = selectedLangs.length > 0
    ? selectedLangs.map(l => LANGS[l].label).join(' or ')
    : 'Sinhala, English, or Tamil';

  return (
    <div className="app">

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <header className="header">
        <div className="header__brand">
          <svg className="header__logo" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round"
            strokeLinejoin="round">
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
          </svg>
          <span className="header__title">VoxLive</span>
          <span className="header__sub">Powered by Google Chirp</span>
        </div>

        {/* Mode Switcher */}
        <div className="mode-selector">
          <button
            className={`mode-btn${mode === 'live' ? ' mode-btn--active' : ''}`}
            onClick={() => setMode('live')}
            disabled={isRecording || isConnecting}
          >
            Live Mode
          </button>
          <button
            className={`mode-btn${mode === 'speaker' ? ' mode-btn--active' : ''}`}
            onClick={() => setMode('speaker')}
            disabled={isRecording || isConnecting}
          >
            Speaker Separation
          </button>
        </div>

        <div className={[
          'pill',
          isRecording ? 'pill--live' : '',
          isConnecting ? 'pill--connecting' : '',
        ].join(' ').trim()}>
          <span className="pill__dot" />
          {isRecording ? 'LIVE' : isConnecting ? 'CONNECTING…' : 'IDLE'}
        </div>
      </header>

      {/* ── Language cards ─────────────────────────────────────────────── */}
      <section className="cards">
        {LANG_ORDER.map(lang => (
          <LangCard
            key={lang}
            lang={lang}
            isActive={selectedLangs.includes(lang) || (selectedLangs.length === 0 && activeLang === lang)}
            onClick={() => handleLangToggle(lang)}
            disabled={isRecording || isConnecting}
          />
        ))}
      </section>

      {/* ── Latency Guide Notice ───────────────────────────────────────── */}
      <LatencyGuide hasSelection={selectedLangs.length > 0} />

      {/* ── Transcript panel ───────────────────────────────────────────── */}
      <section className="panel">
        <div className="panel__head">
          <span className="panel__title">
            {mode === 'speaker' ? 'Speaker Transcript' : 'Live Transcript'}
          </span>
          <div className="btn-action-group">
            {(segments.length > 0 || diarizedSegments.length > 0) && (
              <button className="btn-action btn-action--primary" onClick={downloadTranscript}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
                  strokeLinecap="round" strokeLinejoin="round" width="14" height="14">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                Download
              </button>
            )}
            {(segments.length > 0 || diarizedSegments.length > 0) && (
              <button className="btn-action" onClick={clearTranscript}>
                Clear
              </button>
            )}
          </div>
        </div>

        <div className="panel__body" role="log" aria-live="polite" aria-label="Transcript">
          {/* Empty Placeholder */}
          {segments.length === 0 && diarizedSegments.length === 0 && !interim.text && !isAnalyzing && !(isRecording && mode === 'speaker') && (
            <p className="empty">
              {isRecording
                ? `Listening — start speaking in ${targetLangsLabel}`
                : `Press the mic button below to begin transcribing in ${targetLangsLabel}`}
            </p>
          )}

          {/* Diarization loading spinner */}
          {isAnalyzing && (
            <div className="spinner-wrap">
              <div className="spinner" />
              <p style={{ fontSize: '0.85rem', fontWeight: 600 }}>Separating speakers and identifying languages...</p>
            </div>
          )}

          {/* Diarization recording visualizer waveform */}
          {isRecording && mode === 'speaker' && (
            <div className="waveform-anim-container" style={{ margin: 'auto', textAlign: 'center', padding: '24px 0' }}>
              <div className="waveform-anim">
                <div className="waveform-bar" />
                <div className="waveform-bar" />
                <div className="waveform-bar" />
                <div className="waveform-bar" />
                <div className="waveform-bar" />
              </div>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-3)', fontWeight: 600 }}>Recording voice segments...</p>
            </div>
          )}

          {/* Render Diarization Results */}
          {!isAnalyzing && mode === 'speaker' && diarizedSegments.length > 0 && (
            <>
              {wasDiarizationTruncated && (
                <div className="trunc-warn">
                  ⚠️ Speaker separation is limited to the first 60 seconds of audio.
                </div>
              )}
              <div className="diarized-timeline">
                {diarizedSegments.map((seg, idx) => {
                  let spkClass = 'speaker-bubble--spk-default';
                  if (seg.speaker.endsWith('1')) spkClass = 'speaker-bubble--spk-1';
                  else if (seg.speaker.endsWith('2')) spkClass = 'speaker-bubble--spk-2';
                  else if (seg.speaker.endsWith('3')) spkClass = 'speaker-bubble--spk-3';

                  return (
                    <div key={idx} className={`speaker-bubble ${spkClass}`}>
                      <div className="speaker-bubble__header">
                        <span className="speaker-bubble__name">{seg.speaker}</span>
                        <LangBadge lang={seg.lang} />
                      </div>
                      <div className="speaker-bubble__text">{seg.text}</div>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {/* Render Live Mode Transcripts */}
          {(mode === 'live' || isRecording) && (
            <>
              {/* 1. Finalized Segments */}
              {segments.map(seg => (
                <div key={seg.id} className="seg">
                  <LangBadge lang={seg.lang} />
                  <span className="seg__text">{seg.text}</span>
                  {seg.confidence > 0 && (
                    <span className="seg__conf" title="Confidence">
                      {Math.round(seg.confidence * 100)}%
                    </span>
                  )}
                </div>
              ))}

              {/* 2. Real-time Interim (Live Typing) Segment */}
              {isRecording && interim.text && (
                <div className="seg" style={{ opacity: 0.6 }}>
                  <LangBadge lang={interim.lang} />
                  <span className="seg__text">{interim.text}</span>
                </div>
              )}
            </>
          )}

          <div ref={bottomRef} />
        </div>
      </section>

      {/* ── Error banner ───────────────────────────────────────────────── */}
      {error && (
        <div className="error" role="alert">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            width="16" height="16" style={{ flexShrink: 0 }}>
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          {error}
        </div>
      )}

      {/* ── Mic button (fixed bottom-centre) ───────────────────────────── */}
      <div className="fab-wrap">
        {isRecording && <span className="ripple" />}
        <button
          className={[
            'fab',
            isRecording ? 'fab--active' : '',
            isConnecting ? 'fab--connecting' : '',
          ].join(' ').trim()}
          onClick={isRecording ? stopRecording : () => startRecording(selectedLangs, mode)}
          disabled={isConnecting || isAnalyzing}
          aria-label={isRecording ? 'Stop recording' : 'Start recording'}
        >
          {isRecording ? <StopIcon /> : <MicIcon />}
        </button>
        <span className="fab-label">
          {isConnecting ? 'Connecting…' : isAnalyzing ? 'Analyzing…' : isRecording ? 'Tap to stop' : 'Tap to speak'}
        </span>
      </div>

    </div>
  );
}