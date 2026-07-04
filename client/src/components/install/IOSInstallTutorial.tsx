// ============================================================================
// IOSInstallTutorial — iOS "Add to Home Screen" nudge + how-to modal
// ============================================================================
// iOS has no `beforeinstallprompt`, so we can't one-tap install — we show a
// bottom bar that opens a modal walking through the Share → Add to Home
// Screen → Add flow. Shown on any iOS browser whose share sheet exposes the
// install path (Safari, Chrome iOS, etc.), when not already standalone and
// not dismissed. Terminal aesthetic; no push copy (CamBridge has no push).
// ============================================================================

import { useEffect, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { useInstallState } from '../../hooks/useInstallState';
import { InstallCard } from './InstallCard';

export default function IOSInstallTutorial() {
  const { shouldShowIOSTutorial, dismissPromptForever } = useInstallState();
  const [hiddenThisSession, setHiddenThisSession] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);

  // Lock body scroll while the modal is open (stops iOS bounce behind it).
  useEffect(() => {
    if (!modalOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [modalOpen]);

  // Esc closes the modal.
  useEffect(() => {
    if (!modalOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setModalOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [modalOpen]);

  if (!shouldShowIOSTutorial || hiddenThisSession) return null;

  const dontAsk = () => {
    dismissPromptForever();
    setHiddenThisSession(true);
    setModalOpen(false);
  };

  return (
    <>
      <InstallCard
        subtitle="Add CamBridge to your Home Screen for a full-screen, one-tap camera."
        onClose={() => setHiddenThisSession(true)}
        primary={{ label: 'Show me how', onClick: () => setModalOpen(true) }}
        onDontAsk={dontAsk}
      />

      {modalOpen && (
        <div role="dialog" aria-modal="true" aria-label="How to install CamBridge on iOS" style={overlay}>
          <div style={backdrop} onClick={() => setModalOpen(false)} aria-hidden="true" />
          <div className="panel" style={sheet}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
              <div>
                <div className="wordmark" style={{ fontSize: 18 }}>
                  INSTALL CAMBRIDGE
                </div>
                <p style={{ fontSize: 12, color: 'var(--muted)', margin: '4px 0 0' }}>
                  Three quick steps in your browser.
                </p>
              </div>
              <button type="button" onClick={() => setModalOpen(false)} aria-label="Close" style={closeBtn}>
                ×
              </button>
            </div>

            <ol style={steps}>
              <Step
                n={1}
                title="Tap the Share button"
                body={
                  <>
                    In the browser toolbar, tap the{' '}
                    <ShareIcon style={inlineIcon} /> icon. (On iPad it's near the top.)
                  </>
                }
              />
              <Step
                n={2}
                title={'Choose "Add to Home Screen"'}
                body={
                  <>
                    Scroll the share sheet — it's near the bottom, with a{' '}
                    <PlusIcon style={inlineIcon} /> icon.
                  </>
                }
              />
              <Step
                n={3}
                title={'Tap "Add"'}
                body={
                  <>
                    Confirm the name (CamBridge) and tap Add. Open it from your Home Screen for the
                    full-screen camera.
                  </>
                }
              />
            </ol>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
              <button type="button" className="btn primary" onClick={() => setModalOpen(false)} style={{ flex: 1 }}>
                Got it
              </button>
              <button type="button" onClick={dontAsk} style={dontAskBtn}>
                Don't show again
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── step row + iOS glyphs ───────────────────────────────────────────────────
function Step({ n, title, body }: { n: number; title: string; body: ReactNode }) {
  return (
    <li style={{ display: 'flex', gap: 12 }}>
      <span aria-hidden="true" style={stepNum}>
        {n}
      </span>
      <div style={{ flex: 1, paddingTop: 1 }}>
        <p style={{ fontWeight: 700, fontSize: 14, margin: 0, color: 'var(--text)' }}>{title}</p>
        <p style={{ fontSize: 13, color: 'var(--muted-2)', lineHeight: 1.45, margin: '2px 0 0' }}>{body}</p>
      </div>
    </li>
  );
}

const ShareIcon = ({ style }: { style?: CSSProperties }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={style} aria-hidden="true">
    <path d="M12 3v13" />
    <polyline points="7 8 12 3 17 8" />
    <path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" />
  </svg>
);

const PlusIcon = ({ style }: { style?: CSSProperties }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={style} aria-hidden="true">
    <rect x="4" y="4" width="16" height="16" rx="3" />
    <path d="M12 8v8M8 12h8" />
  </svg>
);

// ── styles ───────────────────────────────────────────────────────────────────
const overlay: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 9999,
  display: 'flex',
  alignItems: 'flex-end',
  justifyContent: 'center',
  paddingTop: 'env(safe-area-inset-top)',
};

const backdrop: CSSProperties = {
  position: 'absolute',
  inset: 0,
  background: 'rgba(0,0,0,0.6)',
  backdropFilter: 'blur(4px)',
  WebkitBackdropFilter: 'blur(4px)',
};

const sheet: CSSProperties = {
  position: 'relative',
  width: '100%',
  maxWidth: 440,
  borderTopLeftRadius: 16,
  borderTopRightRadius: 16,
  borderBottomLeftRadius: 0,
  borderBottomRightRadius: 0,
  borderColor: 'var(--accent-dim)',
  maxHeight: '88vh',
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
  paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 16px)',
};

const steps: CSSProperties = {
  listStyle: 'none',
  padding: 0,
  margin: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
  borderTop: '1px solid var(--border)',
  paddingTop: 16,
};

const stepNum: CSSProperties = {
  flexShrink: 0,
  width: 26,
  height: 26,
  borderRadius: 999,
  border: '1px solid var(--accent-dim)',
  color: 'var(--accent)',
  background: 'color-mix(in srgb, var(--accent) 10%, transparent)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 12,
  fontWeight: 700,
};

const inlineIcon: CSSProperties = {
  display: 'inline-block',
  verticalAlign: 'text-bottom',
  width: 15,
  height: 15,
  margin: '0 2px',
  color: 'var(--accent)',
};

const closeBtn: CSSProperties = {
  flexShrink: 0,
  background: 'transparent',
  border: 'none',
  color: 'var(--muted)',
  fontSize: 24,
  lineHeight: 1,
  cursor: 'pointer',
  padding: '0 4px',
  marginTop: -2,
};

const dontAskBtn: CSSProperties = {
  borderRadius: 'var(--radius-sm)',
  padding: '10px 12px',
  fontSize: 11,
  fontFamily: 'var(--font-mono)',
  color: 'var(--muted)',
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
};
