import { config } from './config';
import { logger } from './logger';

type TemplateName =
  | 'welcome'
  | 'email_verification'
  | 'password_reset'
  | 'email_change_verification'
  | 'stream_link';

interface RenderedEmail {
  subject: string;
  html: string;
}

function render(template: TemplateName, data: Record<string, string>): RenderedEmail {
  switch (template) {
    case 'welcome':
      return {
        subject: 'Welcome to CamBridge',
        html: `<p>Welcome, ${esc(data.username)} — your CamBridge account is ready.</p>`,
      };
    case 'email_verification':
      return {
        subject: 'Verify your CamBridge email',
        html: `<p>Hi ${esc(data.username)}, confirm your email:</p>
               <p><a href="${esc(data.verificationUrl)}">Verify email</a></p>`,
      };
    case 'email_change_verification':
      return {
        subject: 'Confirm your new CamBridge email',
        html: `<p>Hi ${esc(data.username)}, confirm ${esc(data.newEmail)} for your account:</p>
               <p><a href="${esc(data.verificationUrl)}">Confirm new email</a></p>`,
      };
    case 'password_reset':
      return {
        subject: 'Reset your CamBridge password',
        html: `<p>Hi ${esc(data.username)}, reset your password (expires in ${esc(
          data.expiresInMinutes
        )} min):</p>
               <p><a href="${esc(data.resetUrl)}">Reset password</a></p>
               <p>Requested from ${esc(data.ipAddress || 'unknown')}. Ignore if this wasn't you.</p>`,
      };
    case 'stream_link':
      return {
        subject: `Your CamBridge stream link${data.title ? `: ${data.title}` : ''}`,
        html: `<p>Here's your CamBridge viewer link${data.title ? ` for <b>${esc(data.title)}</b>` : ''}:</p>
               <p><a href="${esc(data.viewerUrl)}">${esc(data.viewerUrl)}</a></p>
               <p>Passcode: <b>${esc(data.passcode)}</b></p>
               <p>Add this URL as a <b>Browser Source</b> in OBS (or any WebRTC viewer)
                  to receive the live camera feed, peer-to-peer.</p>`,
      };
  }
}

function esc(s: string | undefined): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => {
    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return map[c];
  });
}

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  from?: string;
}

interface ProviderResult {
  ok: boolean;
  id?: string;
  error?: string;
}

/**
 * Send an email via Resend (or Brevo). Faithfully emulates mirror-server's
 * proven provider calls — array `to`, `reply_to`, and (crucially) logging the
 * actual provider error BODY so failures are visible in the logs. Honors
 * EMAIL_DRY_RUN. Returns true on success (or dry-run); never throws.
 */
export async function send(msg: EmailMessage): Promise<boolean> {
  if (config.email.dryRun) {
    logger.info({ to: msg.to, subject: msg.subject }, '[email dry-run] not sent');
    return true;
  }
  const from = msg.from || config.email.from;
  try {
    const result =
      config.email.provider === 'brevo' ? await sendBrevo(msg, from) : await sendResend(msg, from);
    if (!result.ok) {
      logger.error({ to: msg.to, subject: msg.subject, error: result.error }, 'email send failed');
      return false;
    }
    logger.info({ to: msg.to, subject: msg.subject, id: result.id }, 'email sent');
    return true;
  } catch (err) {
    logger.error({ err, to: msg.to }, 'email send threw');
    return false;
  }
}

/** Render a template and send it. */
export async function sendTemplate(
  to: string,
  template: TemplateName,
  data: Record<string, string>
): Promise<boolean> {
  const { subject, html } = render(template, data);
  return send({ to, subject, html });
}

/**
 * Deliver a contact/inquiry to the support inbox — emulates mirror-server's
 * feedbackNotifier operator email: sent TO the support inbox with reply_to set
 * to the sender so a reply goes straight back to them.
 */
export async function sendContactInquiry(input: {
  name?: string;
  email: string;
  subject: string;
  message: string;
  ip?: string;
}): Promise<boolean> {
  const to = config.email.supportInbox;
  if (!to) {
    logger.warn({}, 'contact email skipped — SUPPORT_INBOX_EMAIL not set');
    return false;
  }
  const html = `
    <div style="font-family: ui-monospace, 'JetBrains Mono', monospace; max-width: 640px; margin: 0 auto; padding: 24px; background: #0a0a0a; color: #e6e6e6;">
      <h2 style="color: #34e57f; margin: 0 0 16px; letter-spacing: 0.04em;">CAMBRIDGE // CONTACT</h2>
      <table style="width: 100%; border-collapse: collapse;">
        <tr><td style="color: #6b6b72; padding: 4px 0; width: 90px;">From</td><td>${esc(input.name || '—')}</td></tr>
        <tr><td style="color: #6b6b72; padding: 4px 0;">Email</td><td>${esc(input.email)}</td></tr>
        <tr><td style="color: #6b6b72; padding: 4px 0;">Subject</td><td>${esc(input.subject)}</td></tr>
        ${input.ip ? `<tr><td style="color: #6b6b72; padding: 4px 0;">IP</td><td>${esc(input.ip)}</td></tr>` : ''}
      </table>
      <div style="border-top: 1px solid #1f1f23; margin-top: 16px; padding-top: 16px; white-space: pre-wrap; line-height: 1.6;">${esc(
        input.message
      )}</div>
    </div>`;
  return send({
    to,
    replyTo: input.email,
    subject: `[CamBridge Contact] ${input.subject}`,
    html,
    text: `From: ${input.name || '—'} <${input.email}>\nSubject: ${input.subject}\n\n${input.message}`,
  });
}

async function sendResend(msg: EmailMessage, from: string): Promise<ProviderResult> {
  if (!config.email.resendApiKey) return { ok: false, error: 'RESEND_API_KEY not set' };
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.email.resendApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [msg.to],
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
      reply_to: msg.replyTo,
    }),
  });
  if (!res.ok) return { ok: false, error: `Resend ${res.status}: ${await res.text()}` };
  const body = (await res.json().catch(() => ({}))) as { id?: string };
  return { ok: true, id: body.id };
}

async function sendBrevo(msg: EmailMessage, from: string): Promise<ProviderResult> {
  if (!config.email.brevoApiKey) return { ok: false, error: 'BREVO_API_KEY not set' };
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': config.email.brevoApiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      sender: parseFrom(from),
      to: [{ email: msg.to }],
      subject: msg.subject,
      htmlContent: msg.html,
      textContent: msg.text,
      replyTo: msg.replyTo ? { email: msg.replyTo } : undefined,
    }),
  });
  if (!res.ok) return { ok: false, error: `Brevo ${res.status}: ${await res.text()}` };
  const body = (await res.json().catch(() => ({}))) as { messageId?: string };
  return { ok: true, id: body.messageId };
}

function parseFrom(from: string): { name?: string; email: string } {
  const m = from.match(/^(.*?)\s*<(.+?)>$/);
  if (m) return { name: m[1].trim() || undefined, email: m[2].trim() };
  return { email: from.trim() };
}
