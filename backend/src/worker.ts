// backend/src/worker.ts
import { createEmailWorker } from "./workers/emailWorker";
import { emailQueue } from "./queues/emailQueue";
import { prisma } from "./utils/prisma";

console.log("[worker-process] Starting ReachInbox email worker...");

const worker = createEmailWorker();

console.log("[worker-process] Worker listening for email jobs.");

let isShuttingDown = false;

const shutdown = async (signal: string) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[worker-process] Received ${signal}. Gracefully shutting down...`);

  try {
    await worker.close();
    await emailQueue.close();
    await prisma.$disconnect();
    console.log("[worker-process] Cleanup completed successfully.");
    process.exit(0);
  } catch (err: any) {
    console.error("[worker-process] Error during shutdown:", err.message);
    process.exit(1);
  }
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
