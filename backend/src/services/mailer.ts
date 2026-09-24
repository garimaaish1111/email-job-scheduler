import nodemailer, { type Transporter } from "nodemailer";
import type { Sender } from "@prisma/client";
import { env } from "../config/env";

// One pooled transport per sender, created once. A transport holds an open TCP
// connection, so building one per email means a TCP and TLS handshake every time.
const transports = new Map<string, Transporter>();

function getTransport(sender: Sender): Transporter {
  const existing = transports.get(sender.id);
  if (existing) return existing;

  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    // Looks wrong but is right: 587 opens in plaintext and upgrades via STARTTLS.
    // secure: true is for 465, and setting it here hangs with no error.
    secure: false,
    auth: {
      user: sender.smtpUser,
      pass: sender.smtpPass,
    },
    pool: true,
    maxConnections: 3,
  });

  transports.set(sender.id, transport);
  return transport;
}

export interface SendResult {
  messageId: string;
  previewUrl: string | null;
}

export async function sendEmail(params: {
  sender: Sender;
  to: string;
  subject: string;
  body: string;
}): Promise<SendResult> {
  const transport = getTransport(params.sender);

  const info = await transport.sendMail({
    from: `"${params.sender.name}" <${params.sender.email}>`,
    to: params.to,
    subject: params.subject,
    text: params.body,
    html: `<div style="font-family:system-ui,sans-serif;line-height:1.6;white-space:pre-wrap">${params.body}</div>`,
  });

  const preview = nodemailer.getTestMessageUrl(info);

  return {
    messageId: info.messageId,
    previewUrl: typeof preview === "string" ? preview : null,
  };
}

export async function verifyAllTransports(senders: Sender[]): Promise<void> {
  await Promise.all(
    senders.map(async (s) => {
      await getTransport(s).verify();
    })
  );
}

export async function closeAllTransports(): Promise<void> {
  for (const t of transports.values()) {
    t.close();
  }
  transports.clear();
}
