// ============================================================================
// UpdateBanner — "a new version is ready · Reload"
// ============================================================================
// Mirrors the Mirror app's update flow with vite-plugin-pwa's `prompt` mode.
// useRegisterSW registers the service worker (this component is always mounted,
// so registration happens on every route) and flips `needRefresh` when a new
// build's SW is installed and waiting. Tapping Reload activates it and reloads.
//
// The banner UI is hidden on the OBS /viewer route — the SW is still registered
// there, but we never overlay a live scene (and `prompt` mode means the viewer
// is never force-reloaded mid-stream).
// ============================================================================

import type { CSSProperties } from 'react';
import { useLocation } from 'react-router-dom';
import { useRegisterSW } from 'virtual:pwa-register/react';

export default function UpdateBanner() {
  const { pathname } = useLocation();
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW();

  // Register everywhere (hook runs above), but never overlay the OBS viewer.
  if (pathname.startsWith('/viewer') || !needRefresh) return null;

  return (
    <div role="status" aria-live="polite" style={wrap}>
      <div className="panel" style={card}>
        <span aria-hidden="true" style={badge}>
          <RefreshIcon />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="wordmark" style={{ fontSize: 13 }}>
            NEW VERSION READY
          </div>
          <p style={{ fontSize: 12, lineHeight: 1.4, margin: '2px 0 0', color: 'var(--muted-2)' }}>
            Reload to pick up the latest CamBridge.
          </p>
        </div>
        <button type="button" className="btn primary" onClick={() => updateServiceWorker(true)} style={{ flexShrink: 0 }}>
          Reload
        </button>
        <button type="button" onClick={() => setNeedRefresh(false)} aria-label="Dismiss" style={closeBtn}>
          ×
        </button>
      </div>
    </div>
  );
}

const RefreshIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21 12a9 9 0 1 1-2.64-6.36" />
    <polyline points="21 3 21 9 15 9" />
  </svg>
);

const wrap: CSSProperties = {
  position: 'fixed',
  bottom: '1rem',
  left: '50%',
  transform: 'translateX(-50%)',
  zIndex: 9995,
  width: 'calc(100vw - 2rem)',
  maxWidth: 440,
  paddingBottom: 'env(safe-area-inset-bottom)',
};

const card: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '12px 14px',
  borderColor: 'var(--accent-dim)',
  boxShadow: '0 8px 30px rgba(0,0,0,0.55), 0 0 0 1px color-mix(in srgb, var(--accent) 20%, transparent)',
};

const badge: CSSProperties = {
  flexShrink: 0,
  width: 28,
  height: 28,
  borderRadius: 999,
  border: '1px solid var(--accent-dim)',
  color: 'var(--accent)',
  background: 'color-mix(in srgb, var(--accent) 10%, transparent)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

const closeBtn: CSSProperties = {
  flexShrink: 0,
  background: 'transparent',
  border: 'none',
  color: 'var(--muted)',
  fontSize: 20,
  lineHeight: 1,
  cursor: 'pointer',
  padding: '0 2px',
};
