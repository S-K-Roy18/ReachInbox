// backend/src/workers/emailWorker.ts
import { Worker, Job } from "bullmq";
import { redisConnectionOptions } from "../utils/redis";
import { prisma } from "../utils/prisma";
import { EMAIL_QUEUE_NAME, EmailJobData } from "../queues/emailQueue";

export const createEmailWorker = () => {
  const worker = new Worker<EmailJobData, void, "send-email">(
    EMAIL_QUEUE_NAME,
    async (job: Job<EmailJobData, void, "send-email">) => {
      const { campaignId, recipientId, recipientEmail } = job.data;
      const attemptNumber = job.attemptsMade + 1;
      console.log(
        `[email-worker] Processing job ${job.id} (attempt ${attemptNumber}) for recipient ${recipientId} (${recipientEmail})`
      );

      // 1. Fetch current recipient state from DB
      const recipient = await prisma.emailRecipient.findUnique({
        where: { id: recipientId },
      });

      if (!recipient) {
        console.warn(`[email-worker] Recipient ${recipientId} not found in DB. Skipping job.`);
        return;
      }

      // 2. Idempotency check: if already marked SENT, don't re-deliver
      if (recipient.status === "SENT") {
        console.log(`[email-worker] Recipient ${recipientId} already marked as SENT. Skipping duplicate execution.`);
        return;
      }

      // 3. Simulated email delivery (Milestone requirement: simulate only, no real SMTP)
      await new Promise((resolve) => setTimeout(resolve, 80));

      // 4. Mark recipient as SENT in PostgreSQL
      await prisma.emailRecipient.update({
        where: { id: recipientId },
        data: {
          status: "SENT",
          sentTime: new Date(),
          attemptCount: attemptNumber,
          lastError: null,
        },
      });

      console.log(`[email-worker] Recipient ${recipientId} (${recipientEmail}) delivery recorded.`);

      // 5. Check if all recipients for this campaign have completed
      const pendingOrQueuedCount = await prisma.emailRecipient.count({
        where: {
          campaignId,
          status: { in: ["PENDING", "QUEUED"] },
        },
      });

      if (pendingOrQueuedCount === 0) {
        await prisma.emailCampaign.update({
          where: { id: campaignId },
          data: { status: "COMPLETED" },
        });
        console.log(`[email-worker] Campaign ${campaignId} completed all recipients.`);
      }
    },
    {
      connection: redisConnectionOptions,
      concurrency: 5,
    }
  );

  worker.on("failed", async (job, err) => {
    if (!job) return;
    const { recipientId, recipientEmail } = job.data;
    const isFinalAttempt = job.attemptsMade >= (job.opts.attempts || 3);
    const safeErrorMsg = err.message ? err.message.slice(0, 300) : "Delivery error";

    console.error(
      `[email-worker] Job ${job.id} failed for recipient ${recipientId} (${recipientEmail}). Attempt: ${job.attemptsMade}/${job.opts.attempts}. Reason: ${safeErrorMsg}`
    );

    try {
      await prisma.emailRecipient.update({
        where: { id: recipientId },
        data: {
          status: isFinalAttempt ? "FAILED" : "QUEUED",
          attemptCount: job.attemptsMade,
          lastError: safeErrorMsg,
        },
      });
    } catch (dbErr: any) {
      console.error(`[email-worker] Failed to record error for recipient ${recipientId}:`, dbErr.message);
    }
  });

  worker.on("error", (err) => {
    console.error("[email-worker] Worker runtime error:", err.message);
  });

  return worker;
};
