// backend/src/workers/emailWorker.ts
import { DelayedError, Worker, Job } from "bullmq";
import { redisConnectionOptions } from "../utils/redis";
import { prisma } from "../utils/prisma";
import { EMAIL_QUEUE_NAME, EmailJobData } from "../queues/emailQueue";
import { EtherealDeliveryResult, EtherealSmtpError, sendEtherealEmail } from "../services/etherealEmail";
import { RateLimitReservationError, reserveCampaignSendSlot } from "../services/campaignRateLimiter";
import { notifySlackCampaignRateLimit } from "../services/slackIntegration";
import { indexCampaignSafely, indexRecipientSafely } from "../services/elasticsearch";

type EmailSender = (message: { subject: string; body: string }) => Promise<EtherealDeliveryResult>;
type RateLimitNotifier = (userId: number, campaignId: number, hourlyLimit: number) => Promise<void>;

function getSafeErrorMessage(error: Error): string {
  if (error instanceof EtherealSmtpError) return error.message;
  if (error instanceof RateLimitReservationError) return "Campaign rate-limit reservation failed.";
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" && /^[A-Z0-9_-]{1,32}$/.test(code)
    ? `Ethereal SMTP delivery failed (${code}).`
    : "Ethereal SMTP delivery failed.";
}

export const createEmailWorker = (
  sendEmail: EmailSender = sendEtherealEmail,
  notifyRateLimit: RateLimitNotifier = notifySlackCampaignRateLimit
) => {
  const worker = new Worker<EmailJobData, EtherealDeliveryResult | null, "send-email">(
    EMAIL_QUEUE_NAME,
    async (job: Job<EmailJobData, EtherealDeliveryResult | null, "send-email">) => {
      const { campaignId, recipientId } = job.data;
      const attemptNumber = job.attemptsMade + 1;
      console.log(
        `[email-worker] Processing job ${job.id} (attempt ${attemptNumber}) for recipient ${recipientId}`
      );

      // 1. Fetch current recipient state from DB
      const recipient = await prisma.emailRecipient.findUnique({
        where: { id: recipientId },
      });

      if (!recipient) {
        console.warn(`[email-worker] Recipient ${recipientId} not found in DB. Skipping job.`);
        return null;
      }

      // 2. Idempotency check: if already marked SENT, don't re-deliver
      if (recipient.status === "SENT") {
        console.log(`[email-worker] Recipient ${recipientId} already marked as SENT. Skipping duplicate execution.`);
        return null;
      }

      const campaign = await prisma.emailCampaign.findUnique({
        where: { id: campaignId },
        select: { userId: true, hourlyLimit: true, delayBetweenEmails: true, subject: true, body: true },
      });
      if (!campaign) {
        console.warn(`[email-worker] Campaign ${campaignId} not found. Skipping recipient ${recipientId}.`);
        return null;
      }

      if (campaign.hourlyLimit !== null || campaign.delayBetweenEmails > 0) {
        const reservation = await reserveCampaignSendSlot(
          campaignId,
          `${job.id}:${job.attemptsMade}`,
          campaign.hourlyLimit,
          campaign.delayBetweenEmails
        );
        if (reservation.notificationDue && campaign.hourlyLimit !== null) {
          try {
            await notifyRateLimit(campaign.userId, campaignId, campaign.hourlyLimit);
          } catch {
            console.warn(`[slack] Hourly-limit notification failed for campaign ${campaignId}; rate limiting remains active.`);
          }
        }
        if (!reservation.allowed) {
          console.info(`[email-worker] Campaign ${campaignId} send slot delayed by ${reservation.delayMs}ms.`);
          await prisma.emailRecipient.update({
            where: { id: recipientId },
            data: {
              status: "QUEUED",
              scheduledTime: new Date(reservation.scheduledAt),
            },
          });
          void indexRecipientSafely(recipientId);
          await job.moveToDelayed(reservation.scheduledAt, job.token);
          throw new DelayedError();
        }
      }

      const delivery = await sendEmail({ subject: campaign.subject, body: campaign.body });

      // Only mark SENT after the Ethereal SMTP server accepts the test message.
      await prisma.emailRecipient.update({
        where: { id: recipientId },
        data: {
          status: "SENT",
          sentTime: new Date(),
          attemptCount: attemptNumber,
          lastError: null,
        },
      });
      void indexRecipientSafely(recipientId);

      console.log(`[email-worker] Ethereal accepted a test message for recipient ${recipientId}.`);
      if (delivery.previewUrl) {
        console.log(`[email-worker] Ethereal preview: ${delivery.previewUrl}`);
      }

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
        void indexCampaignSafely(campaignId);
        console.log(`[email-worker] Campaign ${campaignId} completed all recipients.`);
      }

      return delivery;
    },
    {
      connection: redisConnectionOptions,
      concurrency: 5,
    }
  );

  worker.on("failed", async (job, err) => {
    if (!job) return;
    const { recipientId } = job.data;
    const isFinalAttempt = job.attemptsMade >= (job.opts.attempts || 3);
    const safeErrorMsg = getSafeErrorMessage(err);

    console.error(
      `[email-worker] Job ${job.id} failed for recipient ${recipientId}. Attempt: ${job.attemptsMade}/${job.opts.attempts}. Reason: ${safeErrorMsg}`
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
      void indexRecipientSafely(recipientId);
    } catch (dbErr: any) {
      console.error(`[email-worker] Failed to record SMTP failure for recipient ${recipientId}.`);
    }
  });

  worker.on("error", (err) => {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "RATE_LIMIT_RESERVATION_FAILED") {
      console.error("[email-worker] Redis rate-limit reservation failed; no email will be sent.");
      return;
    }
    const safeCode = typeof code === "string" && /^[A-Z0-9_-]{1,32}$/.test(code) ? ` (${code})` : "";
    console.error(`[email-worker] Worker runtime error${safeCode}.`);
  });

  return worker;
};
