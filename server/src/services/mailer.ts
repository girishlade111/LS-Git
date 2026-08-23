import type { MailOutboxRepo } from '../db/store.js'

/**
 * Mailer port. The outbox-backed transport is the dev/test implementation
 * (messages persist in mail_outbox and are never exposed over HTTP); a real
 * SMTP adapter plugs in here at deployment time without touching services.
 */
export interface Mailer {
  send(to: string, subject: string, body: string): Promise<void> | void
}

export class OutboxMailer implements Mailer {
  constructor(private outbox: MailOutboxRepo) {}

  send(to: string, subject: string, body: string): void {
    // Bodies contain one-time action links/tokens by design; the outbox is a
    // storage transport, not an application log.
    this.outbox.send(to, subject, body)
  }
}

export function passwordResetEmail(origin: string, token: string): { subject: string; body: string } {
  return {
    subject: 'LSGit password reset',
    body: `Reset your LSGit password using this link (valid for a limited time):\n\n${origin}/#/reset?token=${token}\n\nIf you did not request this, you can safely ignore this email.`,
  }
}

export function verificationEmail(origin: string, token: string): { subject: string; body: string } {
  return {
    subject: 'Verify your LSGit email address',
    body: `Confirm your email address:\n\n${origin}/#/verify-email?token=${token}\n`,
  }
}
