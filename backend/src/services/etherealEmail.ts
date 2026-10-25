import nodemailer, { Transporter } from "nodemailer";
import { env } from "../utils/env";

const ETHEREAL_HOST = "smtp.ethereal.email";
const ETHEREAL_TEST_RECIPIENT = "reachinbox-test@example.invalid";

export interface EtherealCredentials {
  user: string;
  pass: string;
}

export interface EtherealEmail {
  subject: string;
  body: string;
}

export interface EtherealDeliveryResult {
  messageId: string;
  previewUrl: string | null;
}

export type EtherealSmtpStage =
  | "configuration"
  | "DNS"
  | "TCP connection"
  | "SMTP greeting"
  | "TLS negotiation"
  | "SMTP authentication"
  | "SMTP verification"
  | "message send";

export class EtherealSmtpError extends Error {
  constructor(
    readonly stage: EtherealSmtpStage,
    readonly code: string
  ) {
    super(`Ethereal SMTP ${stage} failed (${code}).`);
    this.name = "EtherealSmtpError";
  }
}

let transporter: Transporter | undefined;
let transporterCredentials: EtherealCredentials | undefined;

function getTransporter(credentials?: EtherealCredentials): Transporter {
  const configuredCredentials = credentials ?? {
    user: env.ETHEREAL_USER ?? "",
    pass: env.ETHEREAL_PASS ?? "",
  };

  if (!configuredCredentials.user || !configuredCredentials.pass) {
    throw new Error("Ethereal SMTP credentials are not configured.");
  }

  if (
    !transporter ||
    transporterCredentials?.user !== configuredCredentials.user ||
    transporterCredentials.pass !== configuredCredentials.pass
  ) {
    transporter?.close();
    transporter = nodemailer.createTransport({
      host: ETHEREAL_HOST,
      port: 587,
      secure: false,
      requireTLS: true,
      dnsTimeout: 5000,
      connectionTimeout: 5000,
      greetingTimeout: 5000,
      socketTimeout: 10000,
      auth: configuredCredentials,
    });
    transporterCredentials = { ...configuredCredentials };
  }

  return transporter;
}

function getSafeCode(error: unknown): string {
  if (typeof error !== "object" || error === null) return "UNKNOWN";
  const details = error as { code?: unknown; originalCode?: unknown };
  for (const code of [details.originalCode, details.code]) {
    if (typeof code === "string" && /^[A-Z0-9_-]{1,32}$/.test(code)) return code;
  }
  return "UNKNOWN";
}

function getVerificationStage(error: unknown): EtherealSmtpStage {
  if (typeof error !== "object" || error === null) return "SMTP verification";
  const details = error as {
    code?: unknown;
    command?: unknown;
    syscall?: unknown;
    responseCode?: unknown;
  };
  const code = getSafeCode(error);
  const command = typeof details.command === "string" ? details.command.toUpperCase() : "";

  if (["EDNS", "ENOTFOUND", "EAI_AGAIN", "EAI_NONAME"].includes(code)) return "DNS";
  if (command.startsWith("AUTH") || code === "EAUTH" || details.responseCode === 535) {
    return "SMTP authentication";
  }
  if (command === "STARTTLS" || code === "ETLS" || code.startsWith("ERR_TLS")) {
    return "TLS negotiation";
  }
  if (details.syscall === "connect" || ["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH"].includes(code)) {
    return "TCP connection";
  }
  if (details.syscall === "read" || command === "CONN") return "SMTP greeting";
  return "SMTP verification";
}

export async function verifyEtherealSmtp(credentials?: EtherealCredentials): Promise<void> {
  let currentTransporter: Transporter;
  try {
    currentTransporter = getTransporter(credentials);
  } catch {
    throw new EtherealSmtpError("configuration", "NOT_CONFIGURED");
  }

  try {
    await currentTransporter.verify();
  } catch (error) {
    throw new EtherealSmtpError(getVerificationStage(error), getSafeCode(error));
  }
}

export function closeEtherealSmtp(): void {
  transporter?.close();
  transporter = undefined;
  transporterCredentials = undefined;
}

/**
 * Verify the Ethereal SMTP connection with a bounded timeout.
 * Logs error details (stage, code, host, port) without exposing credentials.
 */
export async function verifyEtherealSmtpWithTimeout(
  timeoutMs: number = 15000,
  credentials?: EtherealCredentials
): Promise<void> {
  // Obtain a transporter instance (may be cached) so we can close it later.
  let transport: Transporter;
  try {
    transport = getTransporter(credentials);
  } catch {
    throw new EtherealSmtpError("configuration", "NOT_CONFIGURED");
  }

  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new EtherealSmtpError('SMTP verification', 'TIMEOUT')), timeoutMs);
  });

  try {
    await Promise.race([transport.verify(), timeoutPromise]);
    console.log(`[smtp-verify] Ethereal SMTP verified (host=${ETHEREAL_HOST}, port=587)`);
  } catch (err) {
    const stage = err instanceof EtherealSmtpError ? err.stage : getVerificationStage(err);
    const code = err instanceof EtherealSmtpError ? err.code : getSafeCode(err);
    console.error(
      `[smtp-verify] Ethereal SMTP verification failed. Stage=${stage}, Code=${code}, Host=${ETHEREAL_HOST}, Port=587`
    );
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
    // Ensure the underlying connection is closed and the cached transporter cleared.
    transport?.close?.();
    closeEtherealSmtp();
  }
}

export async function sendEtherealEmail(
  message: EtherealEmail,
  credentials?: EtherealCredentials
): Promise<EtherealDeliveryResult> {
  const configuredCredentials = credentials ?? {
    user: env.ETHEREAL_USER ?? "",
    pass: env.ETHEREAL_PASS ?? "",
  };
  const info = await getTransporter(configuredCredentials)
    .sendMail({
      from: { name: "ReachInbox Test", address: configuredCredentials.user },
      to: ETHEREAL_TEST_RECIPIENT,
      subject: `[ReachInbox test] ${message.subject}`,
      text: message.body,
    })
    .catch((error: unknown) => {
      throw new EtherealSmtpError("message send", getSafeCode(error));
    });

  const wasAccepted = info.accepted?.some(
    (address) => String(address).toLowerCase() === ETHEREAL_TEST_RECIPIENT
  ) ?? false;
  if (!wasAccepted) {
    throw new Error("Ethereal SMTP did not accept the test message.");
  }

  const previewUrl = nodemailer.getTestMessageUrl(info);
  return {
    messageId: info.messageId,
    previewUrl: previewUrl ? String(previewUrl) : null,
  };
}