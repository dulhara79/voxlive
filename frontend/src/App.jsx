import { useRef, useEffect, useState } from 'react';
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

function LangCard({ lang, isActive, pct }) {
  const m = LANGS[lang];
  return (
    <div className={`lang-card lang-card--${m.key}${isActive ? ' lang-card--active' : ''}`}>
      <div className="lang-card__header">
        <div>
          <div className="lang-card__native">{m.native}</div>
          <div className="lang-card__label">{m.label}</div>
        </div>
        <div className="lang-card__pct">{Math.round(pct)}%</div>
      </div>
      <div className="lang-card__track">
        <div className="lang-card__fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
         strokeLinecap="round" strokeLinejoin="round" width="32" height="32">
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8"  y1="23" x2="16" y2="23" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="5" />
      <line x1="12" y1="1" x2="12" y2="3" />
      <line x1="12" y1="21" x2="12" y2="23" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
      <line x1="1" y1="12" x2="3" y2="12" />
      <line x1="21" y1="12" x2="23" y2="12" />
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" width="32" height="32">
      <rect x="4" y="4" width="16" height="16" rx="2" />
    </svg>
  );
}

// ── Main app ───────────────────────────────────────────────────────────────
export default function App() {
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem('vox-theme') || null; } catch(e){ return null; }
  });

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark') root.classList.add('theme-dark');
    else root.classList.remove('theme-dark');
    try { if (theme) localStorage.setItem('vox-theme', theme); } catch(e){}
  }, [theme]);
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
      {/* ── Background Effects ────────────────────────────────────────── */}
      <div className="app__bg-blur app__bg-blur--1" />
      <div className="app__bg-blur app__bg-blur--2" />

      {/* ── Main Layout (Header + Content) ────────────────────────────── */}
      <div className="app__layout">
        {/* ── Header ─────────────────────────────────────────────────────── */}
        <header className="app__header">
          <div className="app__header-content">
            {/* Brand Section */}
            <div className="app__brand">
              <div className="app__logo">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" 
                     strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                </svg>
              </div>
              <div className="app__title-group">
                <h1 className="app__title">VoxLive</h1>
                <p className="app__subtitle">Realtime transcription</p>
              </div>
            </div>

            {/* Controls Section */}
            <div className="app__controls">
              <button
                className="app__theme-btn"
                title="Toggle theme"
                aria-label="Toggle theme"
                onClick={() => setTheme(prev => prev === 'dark' ? 'light' : 'dark')}
              >
                {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
              </button>
              <div className={`app__status ${isRecording ? 'app__status--live' : ''} ${isConnecting ? 'app__status--connecting' : ''}`}>
                <span className="app__status-dot" />
                <span className="app__status-text">
                  {isRecording ? 'LIVE' : isConnecting ? 'CONNECTING' : 'IDLE'}
                </span>
              </div>
            </div>
          </div>
        </header>

        {/* ── Content Area ─────────────────────────────────────────────── */}
        <div className="app__content">
          {/* Language Distribution Stats */}
          <section className="app__section lang-dist">
            <h2 className="app__section-title">Language Distribution</h2>
            <div className="lang-dist__grid">
              {LANG_ORDER.map((lang, idx) => (
                <div key={lang} style={{ animationDelay: `${idx * 0.1}s` }}>
                  <LangCard
                    lang={lang}
                    isActive={activeLang === lang}
                    pct={pct(lang)}
                  />
                </div>
              ))}
            </div>
          </section>

          {/* Live Transcript */}
          <section className="app__section transcript">
            <div className="transcript__toolbar">
              <div className="transcript__info">
                <h2 className="app__section-title">Live Transcript</h2>
                <p className="transcript__meta">{segments.length} segments • {total} words</p>
              </div>
              {segments.length > 0 && (
                <button className="app__btn-action" onClick={clearTranscript} title="Clear transcript">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <polyline points="3 6 5 4 21 4 23 6 23 20a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V6" />
                    <line x1="10" y1="11" x2="10" y2="17" />
                    <line x1="14" y1="11" x2="14" y2="17" />
                  </svg>
                  Clear
                </button>
              )}
            </div>

            <div className="transcript__container" role="log" aria-live="polite" aria-label="Live transcript">
              {segments.length === 0 && !interim.text ? (
                <div className="transcript__empty">
                  <div className="transcript__empty-icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                    </svg>
                  </div>
                  <p className="transcript__empty-text">
                    {isRecording
                      ? 'Listening — speak in Sinhala, English, or Tamil'
                      : 'Tap the microphone to begin'}
                  </p>
                </div>
              ) : (
                <div className="transcript__list">
                  {segments.map((seg, idx) => (
                    <div key={seg.id} className="transcript__item" style={{ animationDelay: `${idx * 0.05}s` }}>
                      <LangBadge lang={seg.lang} />
                      <div className="transcript__item-content">
                        <p className="transcript__text">{seg.text}</p>
                        {seg.confidence > 0 && (
                          <span className="transcript__confidence">{Math.round(seg.confidence * 100)}%</span>
                        )}
                      </div>
                    </div>
                  ))}
                  {interim.text && (
                    <div className="transcript__item transcript__item--interim">
                      <LangBadge lang={interim.lang} />
                      <div className="transcript__item-content">
                        <p className="transcript__text">{interim.text}<span className="transcript__cursor" /></p>
                      </div>
                    </div>
                  )}
                  <div ref={bottomRef} />
                </div>
              )}
            </div>
          </section>

          {/* Error Notification */}
          {error && (
            <div className="app__alert app__alert--error" role="alert">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" 
                   width="18" height="18" aria-hidden="true">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              <span>{error}</span>
            </div>
          )}
        </div>
      </div>

      {/* ── Floating Action Button ─────────────────────────────────────– */}
      <div className="app__fab" role="region" aria-label="Recording control">
        {isRecording && <span className="app__fab-ripple" />}
        <button
          className={`app__fab-btn ${isRecording ? 'app__fab-btn--active' : ''} ${isConnecting ? 'app__fab-btn--connecting' : ''}`}
          onClick={isRecording ? stopRecording : startRecording}
          disabled={isConnecting}
          aria-label={isRecording ? 'Stop recording' : 'Start recording'}
        >
          {isRecording ? <StopIcon /> : <MicIcon />}
        </button>
        <span className="app__fab-label">
          {isConnecting ? 'Connecting…' : isRecording ? 'Tap to stop' : 'Tap to speak'}
        </span>
      </div>
    </div>
  );
}
