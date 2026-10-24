// backend/test-pipeline.ts
import { randomUUID } from "crypto";
import { prisma } from "./src/utils/prisma";
import { scheduleCampaign } from "./src/services/emailScheduler";
import { createEmailWorker } from "./src/workers/emailWorker";
import { emailQueue, getEmailJobId } from "./src/queues/emailQueue";

async function runTest() {
  const testId = randomUUID();
  let userId: number | undefined;
  let campaignId: number | undefined;
  let recipientIds: number[] = [];
  let worker: ReturnType<typeof createEmailWorker> | undefined;

  try {
    console.log("--- STARTING SCHEDULING PIPELINE VERIFICATION ---");

    const user = await prisma.user.create({
      data: {
        googleId: `pipeline-test-${testId}`,
        email: `pipeline-${testId}@example.invalid`,
        name: "Disposable Pipeline Test User",
      },
    });
    userId = user.id;

    const requestedStartTime = new Date(Date.now() + 300);
    const campaign = await prisma.emailCampaign.create({
      data: {
        userId: user.id,
        subject: "Pipeline verification",
        body: "Simulated delivery only",
        startTime: requestedStartTime,
        delayBetweenEmails: 1,
        recipients: {
          create: [
            { email: `first-${testId}@example.invalid` },
            { email: `second-${testId}@example.invalid` },
          ],
        },
      },
      include: { recipients: true },
    });
    campaignId = campaign.id;
    recipientIds = campaign.recipients.map((recipient) => recipient.id);

    const firstResult = await scheduleCampaign(campaign.id);
    if (firstResult.scheduledCount !== 2) {
      throw new Error(`Expected 2 scheduled recipients, got ${firstResult.scheduledCount}`);
    }

    const queuedRecipients = await prisma.emailRecipient.findMany({
      where: { campaignId: campaign.id },
      orderBy: { id: "asc" },
    });
    if (queuedRecipients.some((recipient) => recipient.status !== "QUEUED" || !recipient.scheduledTime)) {
      throw new Error("Expected every recipient to be QUEUED with a scheduledTime");
    }
    if (queuedRecipients[0].scheduledTime!.getTime() < requestedStartTime.getTime()) {
      throw new Error("The first recipient was scheduled before campaign startTime");
    }
    if (queuedRecipients[1].scheduledTime!.getTime() - queuedRecipients[0].scheduledTime!.getTime() !== 1000) {
      throw new Error("Recipient scheduledTime values do not honor delayBetweenEmails");
    }

    const originalSchedule = queuedRecipients.map((recipient) => recipient.scheduledTime?.getTime());
    const secondResult = await scheduleCampaign(campaign.id);
    if (secondResult.scheduledCount !== 0) {
      throw new Error(`Expected 0 new recipients on replay, got ${secondResult.scheduledCount}`);
    }

    const replayedRecipients = await prisma.emailRecipient.findMany({
      where: { campaignId: campaign.id },
      orderBy: { id: "asc" },
    });
    if (replayedRecipients.some((recipient, index) => recipient.scheduledTime?.getTime() !== originalSchedule[index])) {
      throw new Error("Replaying scheduling changed persisted scheduledTime values");
    }

    const jobs = await Promise.all(
      recipientIds.map((recipientId) => emailQueue.getJob(getEmailJobId(campaign.id, recipientId)))
    );
    if (jobs.some((job) => !job) || new Set(jobs.map((job) => job?.id)).size !== recipientIds.length) {
      throw new Error("Expected exactly one deterministic queue job per recipient");
    }

    worker = createEmailWorker();
    const deadline = Date.now() + 10000;
    let deliveredRecipients = await prisma.emailRecipient.findMany({ where: { campaignId: campaign.id } });
    while (deliveredRecipients.some((recipient) => recipient.status === "QUEUED") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      deliveredRecipients = await prisma.emailRecipient.findMany({ where: { campaignId: campaign.id } });
    }

    if (deliveredRecipients.some((recipient) => recipient.status !== "SENT" || !recipient.sentTime || recipient.attemptCount < 1)) {
      throw new Error("Not all recipients completed simulated delivery");
    }

    const updatedCampaign = await prisma.emailCampaign.findUnique({ where: { id: campaign.id } });
    if (updatedCampaign?.status !== "COMPLETED") {
      throw new Error(`Campaign expected COMPLETED, got ${updatedCampaign?.status}`);
    }

    console.log("--- PIPELINE VERIFICATION PASSED ---");
  } finally {
    await worker?.close();
    await Promise.all(
      recipientIds.map(async (recipientId) => {
        const job = await emailQueue.getJob(getEmailJobId(campaignId ?? 0, recipientId));
        if (job) await job.remove();
      })
    );
    if (campaignId !== undefined) {
      await prisma.emailCampaign.deleteMany({ where: { id: campaignId } });
    }
    if (userId !== undefined) {
      await prisma.user.deleteMany({ where: { id: userId } });
    }
    await emailQueue.close();
    await prisma.$disconnect();
  }
}

runTest().catch(async (err) => {
  console.error("\nTEST FAILED:", err);
  await prisma.$disconnect();
  process.exit(1);
});
