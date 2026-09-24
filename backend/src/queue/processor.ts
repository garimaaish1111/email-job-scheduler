import { DelayedError, type Job } from "bullmq";
import { EmailStatus } from "@prisma/client";
import { prisma } from "../db/prisma";
import { env } from "../config/env";
import { sendEmail } from "../services/mailer";
import {
  consumeRateLimit,
  msUntilNextHourWindow,
  waitForSendSlot,
} from "../services/rateLimiter";
import { notifyRateLimitReached } from "../services/slack";
import { indexEmail } from "../services/search";
import type { EmailJobData } from "./emailQueue";

const CLAIMABLE = [EmailStatus.SCHEDULED, EmailStatus.RATE_LIMITED];

export type ProcessResult =
  | {
      outcome: "sent";
      emailId: string;
      previewUrl: string | null;
      waitedMs: number;
      startedAt: number;
    }
  | { outcome: "skipped"; emailId: string; reason: string };

export async function processor(
  job: Job<EmailJobData>,
  token?: string
): Promise<ProcessResult> {
  const { emailId } = job.data;

  // Claim the row before doing anything. A single UPDATE takes a row lock, so if
  // two workers race here the loser re-evaluates its WHERE against status
  // 'SENDING', matches nothing, and backs off. This is what actually guarantees
  // an email is sent once; the jobId only dedupes while the job exists in Redis.
  const claim = await prisma.email.updateMany({
    where: { id: emailId, status: { in: CLAIMABLE } },
    data: { status: EmailStatus.SENDING, attempts: { increment: 1 } },
  });

  if (claim.count === 0) {
    return { outcome: "skipped", emailId, reason: "already claimed or terminal" };
  }

  const email = await prisma.email.findUniqueOrThrow({
    where: { id: emailId },
    include: {
      sender: true,
      campaign: { include: { user: { select: { slackWebhook: true } } } },
    },
  });

  const limit = await consumeRateLimit({
    senderId: email.senderId,
    senderLimit: email.campaign.hourlyLimit,
    globalLimit: env.MAX_EMAILS_PER_HOUR_GLOBAL,
  });

  if (!limit.allowed) {
    // Jitter stops every blocked job from being scored at the same millisecond
    // and stampeding the worker at the top of the hour.
    const resumeInMs = msUntilNextHourWindow();
    const jitter = Math.floor(Math.random() * 5000);
    const resumesAt = new Date(Date.now() + resumeInMs + jitter);

    // Give back the attempt: being rate limited is not a failed try.
    await prisma.email.update({
      where: { id: emailId },
      data: { status: EmailStatus.RATE_LIMITED, attempts: { decrement: 1 } },
    });

    await notifyRateLimitReached({
      webhookUrl: email.campaign.user.slackWebhook,
      senderId: email.senderId,
      senderEmail: email.sender.email,
      scope: limit.reason,
      resumesAt,
    });

    // DelayedError tells BullMQ we rescheduled ourselves rather than failing.
    await job.moveToDelayed(resumesAt.getTime(), token);
    throw new DelayedError();
  }

  const waitedMs = await waitForSendSlot(env.MIN_DELAY_BETWEEN_EMAILS_MS);
  const startedAt = Date.now();

  try {
    const result = await sendEmail({
      sender: email.sender,
      to: email.recipientEmail,
      subject: email.subject,
      body: email.body,
    });

    await prisma.email.update({
      where: { id: emailId },
      data: {
        status: EmailStatus.SENT,
        sentAt: new Date(),
        messageId: result.messageId,
        previewUrl: result.previewUrl,
        errorMessage: null,
      },
    });

    await indexEmail({
      emailId: email.id,
      campaignId: email.campaignId,
      userId: email.campaign.userId,
      recipientEmail: email.recipientEmail,
      senderEmail: email.sender.email,
      subject: email.subject,
      body: email.body,
      status: EmailStatus.SENT,
      scheduledAt: email.scheduledAt.toISOString(),
      sentAt: new Date().toISOString(),
    });

    return {
      outcome: "sent",
      emailId,
      previewUrl: result.previewUrl,
      waitedMs,
      startedAt,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    await prisma.email.update({
      where: { id: emailId },
      data: { status: EmailStatus.FAILED, errorMessage: message },
    });

    throw err;
  }
}
