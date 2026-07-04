/**
 * Outbound email (SMTP, via nodemailer). Configured entirely through env vars so
 * credentials never live in the DB — email stays disabled until an operator
 * opts in. Used for password-reset links (and available as a notification
 * channel).
 *
 *   SMTP_HOST        smtp.example.com          (required to enable email)
 *   SMTP_PORT        587                       (default 587)
 *   SMTP_SECURE      false                     (true for implicit TLS on 465)
 *   SMTP_USER / SMTP_PASS                       (optional auth)
 *   SMTP_FROM        "SEO Indexer <no-reply@example.com>"  (default no-reply@<host or localhost>)
 */
import nodemailer, { type Transporter } from 'nodemailer';

export function emailConfigured(): boolean {
  return !!process.env.SMTP_HOST;
}

let _transport: Transporter | null = null;
function transport(): Transporter {
  if (_transport) return _transport;
  _transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT ?? '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  return _transport;
}

function fromAddress(): string {
  return process.env.SMTP_FROM || `SEO Website Indexer <no-reply@${process.env.MAIL_DOMAIN || 'localhost'}>`;
}

export interface Email { to: string; subject: string; text: string; html?: string }

/** Send an email. Returns true on success; throws only for genuinely unexpected
 *  errors so callers can surface config problems on a "send test" action. */
export async function sendEmail(msg: Email): Promise<boolean> {
  if (!emailConfigured()) return false;
  const info = await transport().sendMail({ from: fromAddress(), ...msg });
  return !!info.accepted?.length;
}

/** Verify the SMTP connection/credentials — for a Settings "test" button. */
export async function verifyEmail(): Promise<void> {
  if (!emailConfigured()) throw new Error('SMTP is not configured (set SMTP_HOST).');
  await transport().verify();
}
