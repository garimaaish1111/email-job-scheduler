import { Router } from "express";
import { z } from "zod";
import { EmailStatus } from "@prisma/client";
import { prisma } from "../db/prisma";
import { requireAuth } from "../middleware/auth";
import { searchEmails } from "../services/search";

const router = Router();

const listSchema = z.object({
  status: z.nativeEnum(EmailStatus).optional(),
  view: z.enum(["scheduled", "sent"]).optional(),
  campaignId: z.string().uuid().optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(200).default(50),
});

router.get("/", requireAuth, async (req, res, next) => {
  try {
    const parsed = listSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query", issues: parsed.error.issues });
      return;
    }
    const { status, view, campaignId, page, pageSize } = parsed.data;

    const statusFilter =
      status !== undefined
        ? { status }
        : view === "scheduled"
          ? { status: { in: [EmailStatus.SCHEDULED, EmailStatus.SENDING, EmailStatus.RATE_LIMITED] } }
          : view === "sent"
            ? { status: { in: [EmailStatus.SENT, EmailStatus.FAILED] } }
            : {};

    const where = {
      campaign: { userId: req.user!.id },
      ...(campaignId ? { campaignId } : {}),
      ...statusFilter,
    };

    const [total, emails] = await Promise.all([
      prisma.email.count({ where }),
      prisma.email.findMany({
        where,
        orderBy: view === "sent" ? { sentAt: "desc" } : { scheduledAt: "asc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          recipientEmail: true,
          subject: true,
          body: true,
          status: true,
          scheduledAt: true,
          sentAt: true,
          attempts: true,
          errorMessage: true,
          previewUrl: true,
          sender: { select: { name: true, email: true } },
        },
      }),
    ]);

    res.json({ emails, total, page, pageSize });
  } catch (err) {
    next(err);
  }
});

const searchSchema = z.object({
  q: z.string().max(300).optional(),
  status: z.nativeEnum(EmailStatus).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(25),
});

router.get("/search", requireAuth, async (req, res, next) => {
  try {
    const parsed = searchSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query", issues: parsed.error.issues });
      return;
    }
    const { q, status, page, pageSize } = parsed.data;

    const result = await searchEmails({
      userId: req.user!.id,
      q,
      status,
      from: (page - 1) * pageSize,
      size: pageSize,
    });

    res.json({
      searchAvailable: result.available,
      total: result.total,
      page,
      pageSize,
      hits: result.hits,
    });
  } catch (err) {
    next(err);
  }
});

router.get("/stats", requireAuth, async (req, res, next) => {
  try {
    const grouped = await prisma.email.groupBy({
      by: ["status"],
      where: { campaign: { userId: req.user!.id } },
      _count: { _all: true },
    });

    const stats: Record<string, number> = {
      SCHEDULED: 0,
      SENDING: 0,
      SENT: 0,
      FAILED: 0,
      RATE_LIMITED: 0,
    };
    for (const g of grouped) stats[g.status] = g._count._all;

    res.json({ stats });
  } catch (err) {
    next(err);
  }
});

export default router;
