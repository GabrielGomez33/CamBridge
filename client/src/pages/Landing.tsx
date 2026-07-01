import { Link } from 'react-router-dom';

export default function Landing() {
  return (
    <div
      style={{
        minHeight: '100dvh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        style={{
          maxWidth: 460,
          textAlign: 'center',
          display: 'flex',
          flexDirection: 'column',
          gap: 18,
          padding: 24,
        }}
      >
        <div className="wordmark" style={{ fontSize: 24, letterSpacing: '0.04em' }}>
          CAMBRIDGE <span className="sep">//</span> <span className="accent">P2P CAMERA</span>
        </div>
        <p style={{ color: 'var(--muted)', fontSize: 13, lineHeight: 1.7, margin: 0 }}>
          Stream from any device's camera straight into OBS, peer-to-peer. Create a link, drop it
          into a Browser Source, go live from anywhere.
        </p>
        <Link className="btn primary" to="/broadcaster" style={{ textAlign: 'center' }}>
          Start a stream
        </Link>
        <Link to="/contact" style={{ fontSize: 12, color: 'var(--muted)' }}>
          Contact &amp; inquiries
        </Link>
      </div>
    </div>
  );
}
