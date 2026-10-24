// backend/src/index.ts
import { closeAppSessionStores, createApp } from "./app";
import { env } from "./utils/env";
import { createEmailWorker } from "./workers/emailWorker";
import { registerGracefulShutdown } from "./utils/gracefulShutdown";

const app = createApp();
const worker = createEmailWorker();
const server = app.listen(Number(env.PORT), () => {
  console.log(`Backend listening on http://localhost:${env.PORT}`);
  console.log("Email worker listening on the existing email-dispatch queue.");
});

const shutdown = registerGracefulShutdown({ label: "api-process", worker, server, closeSessionStores: closeAppSessionStores });
server.on("error", (error: NodeJS.ErrnoException) => {
  const code = typeof error.code === "string" && /^[A-Z0-9_-]{1,32}$/.test(error.code) ? ` (${error.code})` : "";
  console.error(`[api-process] HTTP server failed${code}.`);
  void shutdown("HTTP_SERVER_ERROR");
});
