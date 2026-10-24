import { Server } from "node:http";
import { closeEtherealSmtp } from "../services/etherealEmail";
import { emailQueue } from "../queues/emailQueue";
import { prisma } from "./prisma";
import { closeRedisClient } from "./redis";

interface ShutdownOptions {
  label: string;
  worker: { close(): Promise<void> };
  server?: Server;
  closeSessionStores?: () => Promise<void>;
}

export function registerGracefulShutdown({ label, worker, server, closeSessionStores }: ShutdownOptions): (signal: string) => Promise<void> {
  let shutdownPromise: Promise<void> | undefined;

  const shutdown = (signal: string): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      console.log(`[${label}] Received ${signal}. Gracefully shutting down...`);
      let hadCleanupFailure = false;
      const closeResource = async (name: string, close: () => Promise<unknown> | unknown) => {
        try {
          await close();
        } catch {
          hadCleanupFailure = true;
          console.error(`[${label}] Failed to close ${name}.`);
        }
      };

      if (server?.listening) {
        await closeResource("HTTP server", () => new Promise<void>((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
        }));
      }
      await closeResource("email worker", () => worker.close());
      await closeResource("email queue", () => emailQueue.close());
      await closeResource("SMTP transport", closeEtherealSmtp);
      await closeResource("Redis client", closeRedisClient);
      if (closeSessionStores) await closeResource("session stores", closeSessionStores);
      await closeResource("Prisma client", () => prisma.$disconnect());

      if (hadCleanupFailure) process.exitCode = 1;
      console.log(`[${label}] Shutdown cleanup completed.`);
    })();
    return shutdownPromise;
  };

  process.once("SIGINT", () => { void shutdown("SIGINT"); });
  process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
  return shutdown;
}