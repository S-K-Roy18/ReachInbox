// backend/src/services/emailScheduler.ts
import { prisma } from "../utils/prisma";
import { emailQueue, getEmailJobId } from "../queues/emailQueue";
import { indexCampaignSafely, indexRecipientDocumentsSafely } from "./elasticsearch";

export interface SchedulingResult {
  campaignId: number;
  scheduledCount: number;
  firstScheduledAt: Date | null;
  lastScheduledAt: Date | null;
  message?: string;
}

export async function scheduleCampaign(campaignId: number): Promise<SchedulingResult> {
  let schedulingPlan;

  for (let attempt = 0; ; attempt++) {
    try {
      schedulingPlan = await prisma.$transaction(
        async (tx) => {
          const campaign = await tx.emailCampaign.findUnique({
            where: { id: campaignId },
            include: { recipients: { orderBy: { id: "asc" } } },
          });

          if (!campaign) {
            throw new Error(`Campaign with ID ${campaignId} not found.`);
          }

          const pendingRecipients = campaign.recipients.filter((recipient) => recipient.status === "PENDING");
          const queuedRecipients = campaign.recipients.filter((recipient) => recipient.status === "QUEUED");
          const now = Date.now();
          const delayStepMs = Math.max(0, campaign.delayBetweenEmails) * 1000;
          const latestQueuedTime = queuedRecipients.reduce(
            (latest, recipient) => Math.max(latest, recipient.scheduledTime?.getTime() ?? 0),
            0
          );
          const baseTimestamp = Math.max(
            now,
            campaign.startTime.getTime(),
            latestQueuedTime ? latestQueuedTime + delayStepMs : 0
          );

          for (let index = 0; index < pendingRecipients.length; index++) {
            const recipient = pendingRecipients[index];
            await tx.emailRecipient.update({
              where: { id: recipient.id },
              data: {
                status: "QUEUED",
                scheduledTime: new Date(baseTimestamp + index * delayStepMs),
              },
            });
          }

          const recipientsToEnqueue = await tx.emailRecipient.findMany({
            where: { campaignId, status: "QUEUED", scheduledTime: { not: null } },
            orderBy: { id: "asc" },
          });
          const campaignStatus = campaign.startTime.getTime() <= now ? "RUNNING" : "SCHEDULED";

          if (recipientsToEnqueue.length > 0) {
            await tx.emailCampaign.update({
              where: { id: campaignId },
              data: { status: campaignStatus },
            });
          }

          return {
            campaign,
            recipientsToEnqueue,
            scheduledCount: pendingRecipients.length,
          };
        },
        { isolationLevel: "Serializable" }
      );
      break;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== "P2034" || attempt >= 2) {
        throw error;
      }
    }
  }

  const scheduledTimes = schedulingPlan.recipientsToEnqueue
    .map((recipient) => recipient.scheduledTime)
    .filter((scheduledTime): scheduledTime is Date => scheduledTime !== null)
    .sort((first, second) => first.getTime() - second.getTime());
  const firstScheduledAt = scheduledTimes[0] ?? null;
  const lastScheduledAt = scheduledTimes[scheduledTimes.length - 1] ?? null;

  for (const recipient of schedulingPlan.recipientsToEnqueue) {
    if (!recipient.scheduledTime) continue;

    await emailQueue.add(
      "send-email",
      {
        campaignId: schedulingPlan.campaign.id,
        recipientId: recipient.id,
        recipientEmail: recipient.email,
        subject: schedulingPlan.campaign.subject,
        body: schedulingPlan.campaign.body,
      },
      {
        jobId: getEmailJobId(schedulingPlan.campaign.id, recipient.id),
        delay: Math.max(0, recipient.scheduledTime.getTime() - Date.now()),
      }
    );
  }

  if (schedulingPlan.scheduledCount > 0) {
    void indexCampaignSafely(campaignId);
    void indexRecipientDocumentsSafely(schedulingPlan.recipientsToEnqueue.map((recipient) => recipient.id));
  }

  if (schedulingPlan.scheduledCount === 0) {
    return {
      campaignId,
      scheduledCount: 0,
      firstScheduledAt,
      lastScheduledAt,
      message: "No pending recipients found to schedule.",
    };
  }

  console.log(
    `[scheduler] Successfully queued ${schedulingPlan.scheduledCount} recipients for campaign ${campaignId}. First send at: ${firstScheduledAt?.toISOString()}, last send at: ${lastScheduledAt?.toISOString()}`
  );

  return {
    campaignId,
    scheduledCount: schedulingPlan.scheduledCount,
    firstScheduledAt,
    lastScheduledAt,
  };
}
