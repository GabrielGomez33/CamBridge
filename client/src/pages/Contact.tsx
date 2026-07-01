import { useState } from 'react';
import { Link } from 'react-router-dom';
import { apiBase } from '../engine/base.js';

// Public contact / inquiry form. Posts to /cambridge/api/contact, which emails
// the support inbox (reply-to the sender) via Resend.
export default function Contact() {
  const [form, setForm] = useState({ name: '', email: '', subject: '', message: '', company: '' });
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | string>('idle');

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setForm((f) => ({ ...f, [k]: e.target.value }));
    if (status !== 'idle' && status !== 'sending') setStatus('idle');
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setStatus('sending');
    try {
      const r = await fetch(`${apiBase()}/contact`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(form),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'could not send');
      setStatus('sent');
      setForm({ name: '', email: '', subject: '', message: '', company: '' });
    } catch (err) {
      setStatus((err as Error).message || 'could not send');
    }
  }

  return (
    <div style={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <form onSubmit={submit} className="panel" style={{ width: '100%', maxWidth: 520, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="wordmark" style={{ fontSize: 18 }}>
          CAMBRIDGE <span className="sep">//</span> <span className="accent">CONTACT</span>
        </div>
        <p style={{ color: 'var(--muted)', fontSize: 12, margin: 0, lineHeight: 1.6 }}>
          Questions or inquiries? Send a message and we'll reply to your email.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label className="label">Name (optional)</label>
          <input className="input" value={form.name} onChange={set('name')} maxLength={120} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label className="label">Your email</label>
          <input className="input" type="email" inputMode="email" required value={form.email} onChange={set('email')} maxLength={254} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label className="label">Subject</label>
          <input className="input" required value={form.subject} onChange={set('subject')} maxLength={200} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label className="label">Message</label>
          <textarea
            className="input"
            required
            value={form.message}
            onChange={set('message')}
            maxLength={5000}
            rows={6}
            style={{ resize: 'vertical', fontFamily: 'var(--font-mono)' }}
          />
        </div>

        {/* Honeypot — hidden from humans, bots fill it. */}
        <input
          tabIndex={-1}
          autoComplete="off"
          value={form.company}
          onChange={set('company')}
          style={{ position: 'absolute', left: '-9999px', width: 1, height: 1, opacity: 0 }}
          aria-hidden="true"
        />

        <button className="btn primary" type="submit" disabled={status === 'sending' || status === 'sent'}>
          {status === 'sending' ? 'Sending…' : status === 'sent' ? 'Sent ✓' : 'Send message'}
        </button>

        {status === 'sent' && (
          <div style={{ fontSize: 12, color: 'var(--accent)' }}>Thanks — your message is on its way.</div>
        )}
        {status !== 'idle' && status !== 'sending' && status !== 'sent' && (
          <div style={{ fontSize: 12, color: 'var(--danger)' }}>{status}</div>
        )}

        <Link to="/" style={{ fontSize: 12, color: 'var(--muted)' }}>← Back</Link>
      </form>
    </div>
  );
}
