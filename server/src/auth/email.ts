import { config } from '../config';
import { logger } from '../logger';

type TemplateName =
  | 'welcome'
  | 'email_verification'
  | 'password_reset'
  | 'email_change_verification';

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

/**
 * Send a transactional email via Resend or Brevo. Honors EMAIL_DRY_RUN (logs the
 * rendered message instead of sending) so dev/CI never sends real mail.
 */
export async function sendTemplate(
  to: string,
  template: TemplateName,
  data: Record<string, string>
): Promise<void> {
  const { subject, html } = render(template, data);

  if (config.email.dryRun) {
    logger.info({ to, template, subject }, '[email dry-run] not sent');
    return;
  }

  try {
    if (config.email.provider === 'brevo') {
      await sendBrevo(to, subject, html);
    } else {
      await sendResend(to, subject, html);
    }
    logger.info({ to, template }, 'email sent');
  } catch (err) {
    // Never let an email failure break the auth flow; log and move on.
    logger.error({ err, to, template }, 'email send failed');
  }
}

async function sendResend(to: string, subject: string, html: string): Promise<void> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.email.resendApiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ from: config.email.from, to, subject, html }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
}

async function sendBrevo(to: string, subject: string, html: string): Promise<void> {
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': config.email.brevoApiKey, 'content-type': 'application/json' },
    body: JSON.stringify({
      sender: parseFrom(config.email.from),
      to: [{ email: to }],
      subject,
      htmlContent: html,
    }),
  });
  if (!res.ok) throw new Error(`Brevo ${res.status}: ${await res.text()}`);
}

function parseFrom(from: string): { name?: string; email: string } {
  const m = from.match(/^(.*?)\s*<(.+?)>$/);
  if (m) return { name: m[1].trim() || undefined, email: m[2].trim() };
  return { email: from.trim() };
}
