// backend/src/queues/emailQueue.ts
import { Queue } from "bullmq";
import { redisConnectionOptions } from "../utils/redis";
import { EtherealDeliveryResult } from "../services/etherealEmail";

export interface EmailJobData {
  campaignId: number;
  recipientId: number;
}

export const EMAIL_QUEUE_NAME = "email-dispatch";

export const getEmailJobId = (campaignId: number, recipientId: number): string => {
  return `email:${campaignId}:${recipientId}`;
};

export const emailQueue = new Queue<EmailJobData, EtherealDeliveryResult | null, "send-email">(EMAIL_QUEUE_NAME, {
  connection: redisConnectionOptions,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 3000,
    },
    removeOnComplete: {
      count: 1000,
    },
    removeOnFail: {
      count: 5000,
    },
  },
});
