/**
 * Nodemailer SMTP email sender.
 * Used for DreamHost and other custom SMTP providers.
 * DreamHost uses port 465 with secure: true (SSL).
 */

import nodemailer from 'nodemailer';
import type { SendEmailOptions, SendEmailResult } from './email-sender.gmail.js';

export interface SmtpSenderAccount {
  email: string;
  fromName: string;
  auth_type: 'smtp';
  smtp_host: string;
  smtp_port: number;
  smtp_user: string;
  smtp_password: string;
}

export async function sendEmailSmtp(
  to: string,
  subject: string,
  html: string,
  _options: SendEmailOptions = {},
  account: SmtpSenderAccount,
): Promise<SendEmailResult> {
  const secure = account.smtp_port === 465;

  const transporter = nodemailer.createTransport({
    host: account.smtp_host,
    port: account.smtp_port,
    secure,
    auth: {
      user: account.smtp_user,
      pass: account.smtp_password,
    },
  });

  try {
    const info = await transporter.sendMail({
      from: `"${account.fromName}" <${account.email}>`,
      to,
      subject,
      html,
    });
    console.log(`[SMTP] Sent to ${to} via ${account.smtp_host}: ${info.messageId}`);
    return { success: true, messageId: info.messageId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[SMTP] Failed to send to ${to}:`, msg);
    return { success: false, error: msg };
  }
}
