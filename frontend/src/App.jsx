import { useState, useRef, useEffect } from 'react';
import { useTranscription } from './hooks/useTranscription';

// ── Language metadata ──────────────────────────────────────────────────────
const LANGS = {
  'en-US': { label: 'English', native: 'English', short: 'EN', key: 'en' },
  'si-LK': { label: 'Sinhala', native: 'සිංහල',   short: 'SI', key: 'si' },
  'ta-LK': { label: 'Tamil',   native: 'தமிழ்',   short: 'TA', key: 'ta' },
};
const LANG_ORDER = ['en-US', 'si-LK', 'ta-LK'];

// ── Sub-components ─────────────────────────────────────────────────────────
function LangBadge({ lang }) {
  const m = LANGS[lang] ?? LANGS['en-US'];
  return <span className={`badge badge--${m.key}`}>{m.short}</span>;
}

function LangCard({ lang, isActive, pct, onClick, disabled }) {
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
      <div className="card__track">
        <div className="card__fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="card__pct">{Math.round(pct)}%</div>
    </div>
  );
}

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
         strokeLinecap="round" strokeLinejoin="round" width="28" height="28">
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8"  y1="23" x2="16" y2="23" />
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
  const [selectedLang, setSelectedLang] = useState(null);
  const {
    isRecording, isConnecting,
    segments, interim, langStats,
    error,
    startRecording, stopRecording, clearTranscript,
  } = useTranscription();

  const bottomRef = useRef(null);

  // Auto-scroll transcript to latest entry
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [segments.length, interim.text]);

  // Compute language percentages
  const total = Object.values(langStats).reduce((a, b) => a + b, 0);
  const pct   = (lang) => total > 0 ? ((langStats[lang] ?? 0) / total) * 100 : 0;

  // Active language = most-recent final segment, or current interim
  const activeLang = segments.length > 0
    ? segments[segments.length - 1].lang
    : interim.text
    ? interim.lang
    : null;

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
        <div className={[
          'pill',
          isRecording  ? 'pill--live'       : '',
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
            isActive={selectedLang === lang || (selectedLang === null && activeLang === lang)}
            pct={pct(lang)}
            onClick={() => setSelectedLang(prev => prev === lang ? null : lang)}
            disabled={isRecording || isConnecting}
          />
        ))}
      </section>

      {/* ── Transcript panel ───────────────────────────────────────────── */}
      <section className="panel">
        <div className="panel__head">
          <span className="panel__title">Live Transcript</span>
          {segments.length > 0 && (
            <button className="btn-clear" onClick={clearTranscript}>Clear</button>
          )}
        </div>

        <div className="panel__body" role="log" aria-live="polite" aria-label="Transcript">
          {segments.length === 0 && !interim.text && (
            <p className="empty">
              {isRecording
                ? selectedLang
                  ? `Listening — start speaking in ${LANGS[selectedLang].label}`
                  : 'Listening — start speaking in Sinhala, English, or Tamil (Auto Detect)'
                : selectedLang
                  ? `Press the mic button below to start transcribing in ${LANGS[selectedLang].label}`
                  : 'Press the mic button below to begin (Auto Detect)'}
            </p>
          )}

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

          {interim.text && (
            <div className="seg seg--interim">
              <LangBadge lang={interim.lang} />
              <span className="seg__text">{interim.text}<span className="cursor" /></span>
            </div>
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
            <line x1="12" y1="8"  x2="12"   y2="12" />
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
            isRecording  ? 'fab--active'      : '',
            isConnecting ? 'fab--connecting'  : '',
          ].join(' ').trim()}
          onClick={isRecording ? stopRecording : () => startRecording(selectedLang)}
          disabled={isConnecting}
          aria-label={isRecording ? 'Stop recording' : 'Start recording'}
        >
          {isRecording ? <StopIcon /> : <MicIcon />}
        </button>
        <span className="fab-label">
          {isConnecting ? 'Connecting…' : isRecording ? 'Tap to stop' : 'Tap to speak'}
        </span>
      </div>

    </div>
  );
}
