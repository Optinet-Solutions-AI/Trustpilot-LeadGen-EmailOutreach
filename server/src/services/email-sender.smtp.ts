/**
 * Nodemailer SMTP email sender.
 * Used for DreamHost and other custom SMTP providers.
 * DreamHost uses port 465 with secure: true (SSL).
 */

import fs from 'fs';
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

async function fetchScreenshot(screenshotPath: string): Promise<Buffer | null> {
  if (!screenshotPath) return null;
  if (screenshotPath.startsWith('http')) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(screenshotPath);
        if (res.ok) return Buffer.from(await res.arrayBuffer());
        console.warn(`[SMTP] Screenshot fetch attempt ${attempt} failed: HTTP ${res.status}`);
      } catch (e) {
        console.warn(`[SMTP] Screenshot fetch attempt ${attempt} error:`, e instanceof Error ? e.message : e);
      }
      if (attempt < 3) await new Promise(r => setTimeout(r, 1000));
    }
    return null;
  }
  if (fs.existsSync(screenshotPath)) return fs.readFileSync(screenshotPath);
  return null;
}

// Persistent pooled transporters keyed by SMTP user — avoids a new TLS handshake per send.
const transporterCache = new Map<string, nodemailer.Transporter>();

function getTransporter(account: SmtpSenderAccount): nodemailer.Transporter {
  const cached = transporterCache.get(account.smtp_user);
  if (cached) return cached;

  const secure = account.smtp_port === 465;
  const transporter = nodemailer.createTransport({
    pool: true,
    maxConnections: 2,
    maxMessages: 100,
    host: account.smtp_host,
    port: account.smtp_port,
    secure,
    auth: {
      user: account.smtp_user,
      pass: account.smtp_password,
    },
  });
  transporterCache.set(account.smtp_user, transporter);
  return transporter;
}

export async function sendEmailSmtp(
  to: string,
  subject: string,
  html: string,
  options: SendEmailOptions = {},
  account: SmtpSenderAccount,
): Promise<SendEmailResult> {
  const transporter = getTransporter(account);

  // Embed screenshot as CID inline attachment if provided
  let bodyHtml = html;
  const attachments: Array<{ filename: string; content: Buffer; contentType: string; cid: string; contentDisposition: 'inline' }> = [];

  if (options.screenshotPath) {
    const screenshotBuffer = await fetchScreenshot(options.screenshotPath);
    if (screenshotBuffer) {
      attachments.push({
        filename: 'trustpilot-profile.png',
        content: screenshotBuffer,
        contentType: 'image/png',
        cid: 'trustpilot-screenshot',
        contentDisposition: 'inline',
      });
      bodyHtml = `${bodyHtml}\n<br/><img src="cid:trustpilot-screenshot" alt="Your Trustpilot Profile" style="width:100%;max-width:550px;height:auto;border:1px solid #e2e8f0;border-radius:8px;display:block;margin-top:12px;" />`;
    } else {
      console.warn('[SMTP] Screenshot not embedded — fetch returned null');
    }
  }

  try {
    const info = await transporter.sendMail({
      from: `"${account.fromName}" <${account.email}>`,
      to,
      subject,
      html: bodyHtml,
      attachments,
    });
    console.log(`[SMTP] Sent to ${to} via ${account.smtp_host}: ${info.messageId}`);
    return { success: true, messageId: info.messageId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[SMTP] Failed to send to ${to}:`, msg);
    return { success: false, error: msg };
  }
}
