// backend/src/worker.ts
import { createEmailWorker } from "./workers/emailWorker";
import { registerGracefulShutdown } from "./utils/gracefulShutdown";

console.log("[worker-process] Starting ReachInbox email worker...");

const worker = createEmailWorker();

console.log("[worker-process] Worker listening for email jobs.");
registerGracefulShutdown({ label: "worker-process", worker });
