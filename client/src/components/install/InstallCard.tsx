// ============================================================================
// InstallCard — the shared bottom-anchored install bar (terminal aesthetic)
// ============================================================================
// Used by both InstallPrompt (Android/desktop one-tap) and IOSInstallTutorial
// (iOS "show me how"). Fixed to the bottom center, honors the safe-area inset,
// and matches CamBridge's panel/btn styling.
// ============================================================================

import type { CSSProperties } from 'react';

interface InstallCardProps {
  subtitle: string;
  onClose: () => void;
  primary: { label: string; onClick: () => void; disabled?: boolean };
  onDontAsk: () => void;
}

export function InstallCard({ subtitle, onClose, primary, onDontAsk }: InstallCardProps) {
  return (
    <div role="status" aria-live="polite" style={wrap}>
      <div className="panel" style={card}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <img src="/cambridge/pwa-192x192.png" alt="" aria-hidden="true" width={44} height={44} style={icon} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="wordmark" style={{ fontSize: 14 }}>
              INSTALL CAMBRIDGE
            </div>
            <p style={{ fontSize: 12, lineHeight: 1.45, margin: '3px 0 0', color: 'var(--muted-2)' }}>
              {subtitle}
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Dismiss" style={closeBtn}>
            ×
          </button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 }}>
          <button
            type="button"
            className="btn primary"
            onClick={primary.onClick}
            disabled={primary.disabled}
            style={{ flex: 1 }}
          >
            {primary.label}
          </button>
          <button type="button" onClick={onDontAsk} style={dontAskBtn}>
            Don't ask again
          </button>
        </div>
      </div>
    </div>
  );
}

const wrap: CSSProperties = {
  position: 'fixed',
  bottom: '1rem',
  left: '50%',
  transform: 'translateX(-50%)',
  zIndex: 9990,
  width: 'calc(100vw - 2rem)',
  maxWidth: 440,
  paddingBottom: 'env(safe-area-inset-bottom)',
};

const card: CSSProperties = {
  borderColor: 'var(--accent-dim)',
  boxShadow: '0 8px 30px rgba(0,0,0,0.55), 0 0 0 1px color-mix(in srgb, var(--accent) 20%, transparent)',
};

const icon: CSSProperties = {
  width: 44,
  height: 44,
  flexShrink: 0,
  borderRadius: 10,
  objectFit: 'cover',
  border: '1px solid var(--border-bright)',
};

const closeBtn: CSSProperties = {
  flexShrink: 0,
  background: 'transparent',
  border: 'none',
  color: 'var(--muted)',
  fontSize: 22,
  lineHeight: 1,
  cursor: 'pointer',
  padding: '0 2px',
  marginTop: -2,
};

const dontAskBtn: CSSProperties = {
  borderRadius: 'var(--radius-sm)',
  padding: '8px 12px',
  fontSize: 11,
  fontFamily: 'var(--font-mono)',
  color: 'var(--muted)',
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
};
