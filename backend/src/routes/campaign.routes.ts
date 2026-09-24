import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { EmailStatus } from "@prisma/client";
import { prisma } from "../db/prisma";
import { env } from "../config/env";
import { requireAuth } from "../middleware/auth";
import { emailQueue } from "../queue/emailQueue";
import { indexEmailsBulk } from "../services/search";

const router = Router();

const createSchema = z.object({
  subject: z.string().min(1).max(500),
  body: z.string().min(1),
  startTime: z.coerce.date(),
  delayBetweenMs: z.coerce.number().int().nonnegative().default(0),
  hourlyLimit: z.coerce
    .number()
    .int()
    .positive()
    .default(env.MAX_EMAILS_PER_HOUR_PER_SENDER),
  recipients: z.array(z.string().email()).min(1).max(50000),
});

router.post("/", requireAuth, async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid payload", issues: parsed.error.issues });
      return;
    }

    const { subject, body, startTime, hourlyLimit } = parsed.data;
    const spacing = Math.max(parsed.data.delayBetweenMs, env.MIN_DELAY_BETWEEN_EMAILS_MS);

    const recipients = Array.from(new Set(parsed.data.recipients.map((r) => r.toLowerCase())));

    const senders = await prisma.sender.findMany({
      where: { active: true },
      orderBy: { createdAt: "asc" },
    });
    if (senders.length === 0) {
      res.status(503).json({ error: "No active senders configured" });
      return;
    }

    const campaignId = randomUUID();
    const startMs = startTime.getTime();

    const rows = recipients.map((recipientEmail, i) => ({
      id: randomUUID(),
      campaignId,
      senderId: senders[i % senders.length]!.id,
      recipientEmail,
      subject,
      body,
      scheduledAt: new Date(startMs + i * spacing),
    }));

    await prisma.$transaction([
      prisma.campaign.create({
        data: {
          id: campaignId,
          userId: req.user!.id,
          subject,
          body,
          startTime,
          delayBetweenMs: spacing,
          hourlyLimit,
          totalRecipients: rows.length,
        },
      }),
      prisma.email.createMany({ data: rows }),
    ]);

    // addBulk is one pipelined round trip instead of N. The payload carries only
    // the row id, since job data is serialised into Redis and copying a 5KB body
    // across a thousand jobs wastes megabytes. jobId is the row id so BullMQ
    // rejects a duplicate if this endpoint is called twice.
    const now = Date.now();
    await emailQueue.addBulk(
      rows.map((row) => ({
        name: "send-email",
        data: { emailId: row.id },
        opts: {
          jobId: row.id,
          delay: Math.max(0, row.scheduledAt.getTime() - now),
        },
      }))
    );

    const senderById = new Map(senders.map((s) => [s.id, s.email]));
    void indexEmailsBulk(
      rows.map((row) => ({
        emailId: row.id,
        campaignId,
        userId: req.user!.id,
        recipientEmail: row.recipientEmail,
        senderEmail: senderById.get(row.senderId) ?? "",
        subject: row.subject,
        body: row.body,
        status: EmailStatus.SCHEDULED,
        scheduledAt: row.scheduledAt.toISOString(),
        sentAt: null,
      }))
    );

    res.status(201).json({
      campaignId,
      totalRecipients: rows.length,
      spacingMs: spacing,
      hourlyLimit,
      firstSendAt: rows[0]!.scheduledAt,
      lastSendAt: rows[rows.length - 1]!.scheduledAt,
    });
  } catch (err) {
    next(err);
  }
});

router.get("/", requireAuth, async (req, res, next) => {
  try {
    const campaigns = await prisma.campaign.findMany({
      where: { userId: req.user!.id },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    res.json({ campaigns });
  } catch (err) {
    next(err);
  }
});

export default router;
