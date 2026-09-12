import nodemailer from "nodemailer";

// Pluggable email provider (Phase 8) — any SMTP-compatible service works by
// setting these environment variables; nothing about the provider is
// hardcoded. Real values belong in server/.env (gitignored) locally, or the
// deploy platform's environment variable settings — never in source.
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_SECURE = process.env.SMTP_SECURE === "true" || SMTP_PORT === 465;
const MAIL_FROM = process.env.MAIL_FROM || SMTP_USER;

let transporter = null;

// Nodemailer's defaults (2 minutes) would leave an auth request (register,
// login, forgot-password) hanging just as long whenever the SMTP host is
// briefly unreachable. Fail fast instead — sendMail already treats a
// failure as non-fatal to the calling route.
const SMTP_TIMEOUT_MS = 10_000;

function getTransporter() {
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_SECURE,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
      connectionTimeout: SMTP_TIMEOUT_MS,
      greetingTimeout: SMTP_TIMEOUT_MS,
      socketTimeout: SMTP_TIMEOUT_MS,
    });
  }
  return transporter;
}

export function mailerStatus() {
  return { configured: Boolean(getTransporter()) };
}

/** Sends an email, or logs it to the console and returns { delivered: false }
 * when no SMTP_* env vars are configured — lets auth flows keep working in
 * local dev without a real mail provider set up. Never throws; auth routes
 * shouldn't fail outright just because a notification email couldn't send. */
export async function sendMail({ to, subject, text, html }) {
  const t = getTransporter();
  if (!t) {
    console.warn(`[mailer] SMTP not configured — would have sent to ${to}: ${subject}\n${text}`);
    return { delivered: false, reason: "not_configured" };
  }
  try {
    await t.sendMail({ from: MAIL_FROM, to, subject, text, html });
    return { delivered: true };
  } catch (err) {
    console.error(`[mailer] Failed to send to ${to}:`, err.message);
    return { delivered: false, reason: String(err.message ?? err) };
  }
}
