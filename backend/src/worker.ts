import { Worker } from "bullmq";
import { EmailStatus } from "@prisma/client";
import { env } from "./config/env";
import { prisma } from "./db/prisma";
import { connection } from "./queue/connection";
import { emailQueue, EMAIL_QUEUE_NAME, type EmailJobData } from "./queue/emailQueue";
import { processor } from "./queue/processor";
import { closeAllTransports } from "./services/mailer";
import { ensureIndex } from "./services/search";

// A worker that dies mid-send leaves its row claimed as SENDING. The processor
// will not touch it again, because the claim only accepts SCHEDULED or
// RATE_LIMITED, so without this the email is silently lost and the dashboard
// shows "Sending" forever.
//
// The timeout matters: a row is legitimately SENDING while it waits for its send
// slot, which with high concurrency and a large spacing can be several seconds.
// Only rows older than the timeout are treated as abandoned.
//
// Trade-off: if a process died in the narrow window between SMTP accepting the
// message and the status write, recovery re-sends it. Losing an email outright is
// the worse failure for this system.
async function recoverStalledSends(verbose = false): Promise<void> {
  const cutoff = new Date(Date.now() - env.STALLED_SENDING_TIMEOUT_MS);

  const recovered = await prisma.email.updateMany({
    where: { status: EmailStatus.SENDING, updatedAt: { lt: cutoff } },
    data: { status: EmailStatus.SCHEDULED },
  });

  if (recovered.count > 0) {
    console.log(
      `[recover] ${recovered.count} row(s) abandoned in SENDING returned to SCHEDULED`
    );
    await reconcilePendingJobs();
  } else if (verbose) {
    console.log("[recover] no abandoned sends");
  }
}

// Redis AOF already covers a worker restart. This covers the worse case where
// Redis itself lost its data: Postgres still knows what was due, so the queue is
// rebuilt from it. Anything already past its time goes out immediately, late
// rather than lost.
async function reconcilePendingJobs(): Promise<void> {
  const pending = await prisma.email.findMany({
    where: { status: { in: [EmailStatus.SCHEDULED, EmailStatus.RATE_LIMITED] } },
    select: { id: true, scheduledAt: true },
    orderBy: { scheduledAt: "asc" },
  });

  if (pending.length === 0) {
    console.log("[reconcile] no pending emails in database");
    return;
  }

  const now = Date.now();
  let restored = 0;

  // Existence is not enough. Completed jobs are kept for 24h, so a row recovered
  // from SENDING still has its old finished job in Redis. Only a job in a pending
  // state counts as queued; anything else is stale and gets replaced.
  const PENDING_STATES = ["waiting", "delayed", "active", "prioritized", "waiting-children"];

  for (const row of pending) {
    const existing = await emailQueue.getJob(row.id);

    if (existing) {
      const state = await existing.getState();
      if (PENDING_STATES.includes(state)) continue;
      await existing.remove();
    }

    await emailQueue.add(
      "send-email",
      { emailId: row.id },
      { jobId: row.id, delay: Math.max(0, row.scheduledAt.getTime() - now) }
    );
    restored++;
  }

  console.log(
    `[reconcile] ${pending.length} pending in DB, ${restored} re-queued, ${pending.length - restored} already in queue`
  );
}

async function main(): Promise<void> {
  await ensureIndex();
  await recoverStalledSends(true);
  await reconcilePendingJobs();

  // Boot time recovery alone is not enough: a row abandoned by a crash is not yet
  // past the timeout when the worker comes straight back up, so it would sit
  // stuck until some later restart. Sweeping on a timer lets it heal on its own.
  const sweep = setInterval(() => {
    void recoverStalledSends();
  }, env.STALLED_SENDING_TIMEOUT_MS);

  // concurrency controls how many jobs are in flight at once; the limiter caps how
  // fast they may start, and is Redis backed so it holds across worker processes.
  const worker = new Worker<EmailJobData>(EMAIL_QUEUE_NAME, processor, {
    connection,
    concurrency: env.WORKER_CONCURRENCY,
    limiter: { max: 1, duration: env.MIN_DELAY_BETWEEN_EMAILS_MS },
  });

  worker.on("ready", () => {
    console.log(
      `[worker] ready. concurrency=${env.WORKER_CONCURRENCY} minDelay=${env.MIN_DELAY_BETWEEN_EMAILS_MS}ms`
    );
  });

  worker.on("completed", (job, result) => {
    if (result?.outcome === "skipped") {
      console.log(`[worker] skipped ${job.id}: ${result.reason}`);
      return;
    }
    console.log(
      `[worker] sent ${job.id} startedAt=${result.startedAt} throttleWait=${result.waitedMs}ms`
    );
  });

  worker.on("failed", (job, err) => {
    console.log(`[worker] failed ${job?.id}: ${err.message}`);
  });

  worker.on("error", (err) => {
    console.error("[worker] error", err.message);
  });

  // close() lets in-flight jobs finish and returns unstarted ones to the wait list,
  // instead of leaving them stuck in active until their lock expires.
  const shutdown = async (signal: string) => {
    console.log(`[worker] ${signal} received, draining`);
    clearInterval(sweep);
    await worker.close();
    await closeAllTransports();
    await prisma.$disconnect();
    await connection.quit();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
