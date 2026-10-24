import { env } from "./src/utils/env";
import {
  closeEtherealSmtp,
  EtherealSmtpError,
  verifyEtherealSmtp,
} from "./src/services/etherealEmail";

async function runVerification(): Promise<void> {
  try {
    await verifyEtherealSmtp({
      user: env.ETHEREAL_USER ?? "",
      pass: env.ETHEREAL_PASS ?? "",
    });
    console.log("Ethereal SMTP verification passed; no message was sent.");
  } catch (error) {
    if (error instanceof EtherealSmtpError) {
      console.error(`Ethereal SMTP verification failed at ${error.stage} (${error.code}).`);
    } else {
      console.error("Ethereal SMTP verification failed before completion.");
    }
    process.exitCode = 1;
  } finally {
    closeEtherealSmtp();
  }
}

void runVerification();