import nodemailer from 'nodemailer'
import { env } from '../config/env.js'

function appBaseUrl() {
  return (env.APP_URL || env.FRONTEND_ORIGIN).replace(/\/$/, '')
}

export function buildResetPasswordUrl(rawToken: string) {
  return `${appBaseUrl()}/reset-password?token=${encodeURIComponent(rawToken)}`
}

/**
 * Send password-reset email when SMTP is configured.
 * Development without SMTP: log the reset URL (never the raw token alone without context).
 * Never include the token in API responses.
 */
export async function sendPasswordResetEmail(to: string, rawToken: string) {
  const resetUrl = buildResetPasswordUrl(rawToken)

  if (env.SMTP_HOST) {
    const transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_PORT === 465,
      auth:
        env.SMTP_USER && env.SMTP_PASS
          ? { user: env.SMTP_USER, pass: env.SMTP_PASS }
          : undefined,
    })
    await transporter.sendMail({
      from: env.MAIL_FROM || env.SMTP_USER || 'noreply@localhost',
      to,
      subject: 'Password reset — Parking Device Maintenance',
      text: `Reset your password using this link (expires in 1 hour):\n\n${resetUrl}\n\nIf you did not request this, ignore this email.`,
    })
    return
  }

  if (env.NODE_ENV === 'development' || env.NODE_ENV === 'test') {
    console.info(`[mail] Password reset link for ${to}: ${resetUrl}`)
  }
}
