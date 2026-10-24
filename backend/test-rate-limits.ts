import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createEmailWorker } from "./src/workers/emailWorker";
import { scheduleCampaign } from "./src/services/emailScheduler";
import { prisma } from "./src/utils/prisma";
import { emailQueue, getEmailJobId } from "./src/queues/emailQueue";
import { closeRedisClient, getRedisClient } from "./src/utils/redis";
import {
  getCampaignRateLimitKey,
  getCampaignRateLimitNotificationKey,
  reserveCampaignSendSlot,
} from "./src/services/campaignRateLimiter";

async function runRateLimitTests(): Promise<void> {
  const testId = randomUUID();
  const campaignIds = [
    `rate-test-hourly-${testId}`,
    `rate-test-window-${testId}`,
    `rate-test-gap-${testId}`,
    `rate-test-retry-${testId}`,
  ];
  const redis = getRedisClient();
  const workers: ReturnType<typeof createEmailWorker>[] = [];
  let userId: number | undefined;
  let campaignId: number | undefined;
  let recipientIds: number[] = [];

  try {
    const now = Date.now();
    const concurrentSlots = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        reserveCampaignSendSlot(campaignIds[0], `worker-${index}:0`, 2, 0, now)
      )
    );
    assert.equal(concurrentSlots.filter((slot) => slot.allowed).length, 2);
    assert.equal(concurrentSlots.filter((slot) => slot.notificationDue).length, 1);
    assert(concurrentSlots.filter((slot) => !slot.allowed).every((slot) => slot.scheduledAt >= now + 3600000));

    await reserveCampaignSendSlot(campaignIds[1], "first-window:0", 1, 0, now);
    const nextWindowSlot = await reserveCampaignSendSlot(
      campaignIds[1],
      "next-window:0",
      1,
      0,
      now + 3600000
    );
    assert.equal(nextWindowSlot.allowed, true, "the rolling hourly window should reset after 60 minutes");

    const gapSlots = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        reserveCampaignSendSlot(campaignIds[2], `gap-${index}:0`, null, 4, now)
      )
    );
    const orderedGapTimes = gapSlots.map((slot) => slot.scheduledAt).sort((first, second) => first - second);
    assert.equal(gapSlots.filter((slot) => slot.allowed).length, 1);
    for (let index = 1; index < orderedGapTimes.length; index++) {
      assert(orderedGapTimes[index] - orderedGapTimes[index - 1] >= 4000);
    }

    const firstAttempt = await reserveCampaignSendSlot(campaignIds[3], "same-job:0", null, 10, now);
    const repeatedAttempt = await reserveCampaignSendSlot(campaignIds[3], "same-job:0", null, 10, now);
    const retryAttempt = await reserveCampaignSendSlot(campaignIds[3], "same-job:1", null, 10, now);
    assert.equal(firstAttempt.scheduledAt, now);
    assert.equal(repeatedAttempt.scheduledAt, firstAttempt.scheduledAt, "redelivery of an attempt must reuse its reservation");
    assert.equal(retryAttempt.scheduledAt, now + 10000, "a new BullMQ retry attempt reserves a distinct spaced slot");

    const delayedCampaignId = `rate-test-delayed-${testId}`;
    campaignIds.push(delayedCampaignId);
    await reserveCampaignSendSlot(delayedCampaignId, "first:0", null, 30, now);
    const delayedSlot = await reserveCampaignSendSlot(delayedCampaignId, "delayed:0", null, 30, now);
    const repeatedDelayedSlot = await reserveCampaignSendSlot(delayedCampaignId, "delayed:0", null, 30, now);
    assert.equal(delayedSlot.allowed, false);
    assert.equal(delayedSlot.scheduledAt, now + 30000);
    assert.equal(repeatedDelayedSlot.scheduledAt, delayedSlot.scheduledAt, "rescheduling must retain the original slot");

    const user = await prisma.user.create({
      data: {
        googleId: `rate-worker-${testId}`,
        email: `rate-worker-${testId}@example.invalid`,
      },
    });
    userId = user.id;
    const campaign = await prisma.emailCampaign.create({
      data: {
        userId,
        subject: "Rate-limit worker test",
        body: "Mock transport only",
        startTime: new Date(Date.now() - 1000),
        delayBetweenEmails: 0,
        hourlyLimit: 1,
        recipients: {
          create: [
            { email: `first-${testId}@example.invalid` },
            { email: `second-${testId}@example.invalid` },
            { email: `third-${testId}@example.invalid` },
            { email: `fourth-${testId}@example.invalid` },
          ],
        },
      },
      include: { recipients: true },
    });
    campaignId = campaign.id;
    recipientIds = campaign.recipients.map((recipient) => recipient.id);
    await scheduleCampaign(campaign.id);

    let sentCount = 0;
    let notificationCount = 0;
    const mockEmailSender = async () => {
        sentCount++;
        return { messageId: `mock-${sentCount}`, previewUrl: null };
      };
    const mockFailingSlackNotifier = async () => {
        notificationCount++;
        throw new Error("Mock Slack API failure");
      };
    workers.push(createEmailWorker(mockEmailSender, mockFailingSlackNotifier));
    workers.push(createEmailWorker(mockEmailSender, mockFailingSlackNotifier));

    const processingDeadline = Date.now() + 5000;
    let recipients = await prisma.emailRecipient.findMany({ where: { campaignId } });
    const hasExpectedStates = () =>
      recipients.filter((recipient) => recipient.status === "SENT").length === 1 &&
      recipients.filter((recipient) =>
        recipient.status === "QUEUED" && recipient.scheduledTime !== null && recipient.scheduledTime.getTime() > Date.now()
      ).length === 3;
    while (!hasExpectedStates() && Date.now() < processingDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      recipients = await prisma.emailRecipient.findMany({ where: { campaignId } });
    }
    assert.equal(recipients.filter((recipient) => recipient.status === "SENT").length, 1);
    assert.equal(recipients.filter((recipient) => recipient.status === "QUEUED").length, 3);
    assert.equal(sentCount, 1, "hourly cap must prevent a second mock delivery");
    assert.equal(notificationCount, 1, "concurrent workers should request exactly one Slack notification");

    const delayedRecipients = recipients.filter((recipient) => recipient.status === "QUEUED");
    assert(delayedRecipients.every((recipient) => recipient.scheduledTime && recipient.scheduledTime.getTime() > Date.now()));
    const delayedJobs = await Promise.all(delayedRecipients.map((recipient) => emailQueue.getJob(getEmailJobId(campaign.id, recipient.id))));
    assert(delayedJobs.every(Boolean), "over-limit BullMQ jobs should remain in the queue");
    for (const delayedJob of delayedJobs) {
      assert.equal(await delayedJob!.getState(), "delayed", "over-limit job should be moved to delayed state");
    }
    const delayedJob = delayedJobs[0]!;
    const reservedTime = await redis.zscore(getCampaignRateLimitKey(campaign.id), `${delayedJob.id}:${delayedJob.attemptsMade}`);
    assert(reservedTime, "delayed job should retain its reserved slot in Redis");

    await delayedJob.promote();
    const rescheduleDeadline = Date.now() + 5000;
    let rescheduled = false;
    while (Date.now() < rescheduleDeadline) {
      const state = await delayedJob.getState();
      if (state === "delayed") {
        const currentTime = await redis.zscore(getCampaignRateLimitKey(campaign.id), `${delayedJob.id}:${delayedJob.attemptsMade}`);
        rescheduled = currentTime === reservedTime;
        if (rescheduled) break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert(rescheduled, "promoted job must be delayed again at its original slot without another send");
    assert.equal(sentCount, 1, "rescheduling must not invoke the mock transport");
    assert.equal(notificationCount, 1, "repeated delayed processing must not duplicate the notification");
    assert(workers.every((worker) => worker.isRunning()), "workers should continue after the mocked Slack failure");

    console.log("Campaign rate-limit integration passed: two workers, one Slack attempt, mocked delivery, future delayed jobs, and continued processing after Slack failure.");
  } finally {
    await Promise.all(workers.map((worker) => worker.close()));
    if (campaignId !== undefined) {
      await Promise.all(recipientIds.map(async (recipientId) => {
        const job = await emailQueue.getJob(getEmailJobId(campaignId!, recipientId));
        if (job) await job.remove();
      }));
      await prisma.emailCampaign.deleteMany({ where: { id: campaignId } });
    }
    if (userId !== undefined) await prisma.user.deleteMany({ where: { id: userId } });
    await redis.del(...campaignIds.flatMap((id) => [getCampaignRateLimitKey(id), getCampaignRateLimitNotificationKey(id)]));
    if (campaignId !== undefined) {
      await redis.del(getCampaignRateLimitKey(campaignId), getCampaignRateLimitNotificationKey(campaignId));
    }
    await emailQueue.close();
    await prisma.$disconnect();
    await closeRedisClient();
  }
}

runRateLimitTests().catch((error) => {
  console.error("Campaign rate-limit tests failed.");
  if (error instanceof Error) console.error(error.message);
  process.exitCode = 1;
});