// backend/src/index.ts
import { closeAppSessionStores, createApp } from "./app";
import { env } from "./utils/env";
import { createEmailWorker } from "./workers/emailWorker";
import { registerGracefulShutdown } from "./utils/gracefulShutdown";
import { verifyEtherealSmtpWithTimeout, EtherealSmtpError, getVerificationStage, getSafeCode } from "./services/etherealEmail";

const app = createApp();
const worker = createEmailWorker();
const server = app.listen(Number(env.PORT), () => {
  console.log(`Backend listening on http://localhost:${env.PORT}`);
  console.log("Email worker listening on the existing email-dispatch queue.");
  // Run a one‑off SMTP connectivity check (non‑blocking).
  void verifyEtherealSmtpWithTimeout()
    .then(() => console.log("[smtp-startup] Ethereal SMTP verification succeeded"))
    .catch((err) => {
      const stage = err instanceof EtherealSmtpError ? err.stage : getVerificationStage(err);
      const code = err instanceof EtherealSmtpError ? err.code : getSafeCode(err);
      const finalStage = (code === "TIMEOUT" || code === "ETIMEDOUT") && stage === "SMTP verification"
        ? "overall verification timeout"
        : stage;
      console.error(`[smtp-startup] Ethereal SMTP verification failed. Stage=${finalStage}, Code=${code}, Host=${"smtp.ethereal.email"}, Port=587`);
    })
});

const shutdown = registerGracefulShutdown({ label: "api-process", worker, server, closeSessionStores: closeAppSessionStores });
server.on("error", (error: NodeJS.ErrnoException) => {
  const code = typeof error.code === "string" && /^[A-Z0-9_-]{1,32}$/.test(error.code) ? ` (${error.code})` : "";
  console.error(`[api-process] HTTP server failed${code}.`);
  void shutdown("HTTP_SERVER_ERROR");
});
