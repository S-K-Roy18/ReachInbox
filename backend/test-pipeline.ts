// backend/test-pipeline.ts
import { randomUUID } from "crypto";
import { prisma } from "./src/utils/prisma";
import { scheduleCampaign } from "./src/services/emailScheduler";
import { createEmailWorker } from "./src/workers/emailWorker";
import { emailQueue, getEmailJobId } from "./src/queues/emailQueue";
import { closeRedisClient } from "./src/utils/redis";
import {
  closeEtherealSmtp,
  EtherealCredentials,
  EtherealSmtpError,
  sendEtherealEmail,
  verifyEtherealSmtp,
} from "./src/services/etherealEmail";
import { env } from "./src/utils/env";

let currentTestStage = "test setup";

async function runTest() {
  const testId = randomUUID();
  let userId: number | undefined;
  let campaignId: number | undefined;
  let recipientIds: number[] = [];
  let worker: ReturnType<typeof createEmailWorker> | undefined;

  try {
    console.log("--- STARTING ETHEREAL SCHEDULING PIPELINE VERIFICATION ---");

    currentTestStage = "credential validation";
    const testCredentials: EtherealCredentials = {
      user: env.ETHEREAL_USER ?? "",
      pass: env.ETHEREAL_PASS ?? "",
    };
    if (
      !testCredentials.user ||
      !testCredentials.pass ||
      testCredentials.user.startsWith("your_ethereal_") ||
      testCredentials.pass.startsWith("your_ethereal_")
    ) {
      throw new Error(
        "Ethereal credentials are missing. Set ETHEREAL_USER and ETHEREAL_PASS in backend/.env before running this test."
      );
    }

    currentTestStage = "SMTP verification";
    await verifyEtherealSmtp(testCredentials);
    console.log("Ethereal SMTP verification passed; no message was sent by the preflight.");

    currentTestStage = "test user creation";
    const user = await prisma.user.create({
      data: {
        googleId: `pipeline-test-${testId}`,
        email: `pipeline-${testId}@example.invalid`,
        name: "Disposable Pipeline Test User",
      },
    });
    userId = user.id;

    currentTestStage = "campaign and recipient creation";
    const requestedStartTime = new Date(Date.now() + 300);
    const campaign = await prisma.emailCampaign.create({
      data: {
        userId: user.id,
        subject: "Pipeline verification",
        body: "Ethereal SMTP pipeline verification",
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

    currentTestStage = "campaign scheduling and queue insertion";
    const firstResult = await scheduleCampaign(campaign.id);
    if (firstResult.scheduledCount !== 2) {
      throw new Error(`Expected 2 scheduled recipients, got ${firstResult.scheduledCount}`);
    }

    currentTestStage = "schedule and deterministic-job verification";
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

    currentTestStage = "schedule replay verification";
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

    currentTestStage = "deterministic queue-job verification";
    const jobs = await Promise.all(
      recipientIds.map((recipientId) => emailQueue.getJob(getEmailJobId(campaign.id, recipientId)))
    );
    if (jobs.some((job) => !job) || new Set(jobs.map((job) => job?.id)).size !== recipientIds.length) {
      throw new Error("Expected exactly one deterministic queue job per recipient");
    }

    currentTestStage = "Ethereal message delivery";
    worker = createEmailWorker((message) => sendEtherealEmail(message, testCredentials));
    const deadline = Date.now() + 10000;
    let deliveredRecipients = await prisma.emailRecipient.findMany({ where: { campaignId: campaign.id } });
    while (deliveredRecipients.some((recipient) => recipient.status === "QUEUED") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      deliveredRecipients = await prisma.emailRecipient.findMany({ where: { campaignId: campaign.id } });
    }

    currentTestStage = "delivery status and preview verification";
    if (deliveredRecipients.some((recipient) => recipient.status !== "SENT" || !recipient.sentTime || recipient.attemptCount < 1)) {
      throw new Error("Not all recipients completed Ethereal SMTP delivery");
    }

    const completedJobs = await Promise.all(
      recipientIds.map((recipientId) => emailQueue.getJob(getEmailJobId(campaign.id, recipientId)))
    );
    const previewUrls = completedJobs.map((job) => job?.returnvalue?.previewUrl);
    if (previewUrls.some((url) => typeof url !== "string" || !url.startsWith("https://"))) {
      throw new Error("Expected an Ethereal preview URL for each delivered test message");
    }
    for (const previewUrl of previewUrls) {
      console.log(`Ethereal preview: ${previewUrl}`);
    }

    const updatedCampaign = await prisma.emailCampaign.findUnique({ where: { id: campaign.id } });
    if (updatedCampaign?.status !== "COMPLETED") {
      throw new Error(`Campaign expected COMPLETED, got ${updatedCampaign?.status}`);
    }

    console.log("--- ETHEREAL PIPELINE VERIFICATION PASSED ---");
  } finally {
    currentTestStage = "test cleanup";
    try {
      await worker?.close();
      // Clean up queued jobs – ignore errors if a job was already removed or queue closed
      await Promise.all(
        recipientIds.map(async (recipientId) => {
          try {
            const job = await emailQueue.getJob(getEmailJobId(campaignId ?? 0, recipientId));
            if (job) await job.remove();
          } catch (e) {
            console.warn('Job cleanup error (ignored):', e);
          }
        })
      );
      if (campaignId !== undefined) {
        await prisma.emailCampaign.deleteMany({ where: { id: campaignId } });
      }
      if (userId !== undefined) {
        await prisma.user.deleteMany({ where: { id: userId } });
      }
      await emailQueue.close();
      await closeRedisClient();
      closeEtherealSmtp();
      await prisma.$disconnect();
    } catch (e) {
      console.warn('Test cleanup error (ignored):', e);
    }
  }
}

runTest().catch(async (err) => {
  const code =
    typeof err === "object" && err !== null && "code" in err &&
    typeof err.code === "string" && /^[A-Z0-9_-]{1,32}$/.test(err.code)
      ? err.code
      : undefined;
  const stage = err instanceof EtherealSmtpError ? err.stage : currentTestStage;
  console.error(`\nTEST FAILED during ${stage}${code ? ` (${code})` : ""}.`);
  await prisma.$disconnect();
  process.exit(1);
});
