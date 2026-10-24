import { Request, Response, Router } from "express";
import { CampaignStatus, RecipientStatus } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../utils/prisma";
import { scheduleCampaign } from "../services/emailScheduler";
import { indexCampaignSafely, indexRecipientDocumentsSafely } from "../services/elasticsearch";
import { ensureAuthenticated } from "./auth";

const router = Router();

const createCampaignSchema = z.object({
  subject: z.string().trim().min(1).max(200),
  body: z.string().min(1).max(80000),
  startTime: z.string().datetime({ offset: true }).optional(),
  delayBetweenEmails: z.number().int().min(0).max(86400).default(0),
  hourlyLimit: z.number().int().min(1).max(100000).nullable().optional(),
}).strict();

const addRecipientsSchema = z.object({
  emails: z.array(z.string().trim().email().max(320)).min(1).max(5000),
}).strict();

function getUserId(req: Request): number | undefined {
  const id = (req.user as { id?: unknown } | undefined)?.id;
  return typeof id === "number" && Number.isInteger(id) && id > 0 ? id : undefined;
}

function getCampaignId(req: Request, res: Response): number | undefined {
  const campaignId = Number(req.params.campaignId);
  if (!Number.isSafeInteger(campaignId) || campaignId < 1) {
    res.status(400).json({ error: "Invalid campaign ID." });
    return undefined;
  }
  return campaignId;
}

function sendValidationError(res: Response, error: z.ZodError): void {
  res.status(400).json({
    error: "Invalid request.",
    details: error.issues.map((issue) => ({ field: issue.path.join("."), message: issue.message })),
  });
}

function sendInternalError(res: Response, operation: string, error: unknown): void {
  const code =
    typeof error === "object" && error !== null && "code" in error &&
    typeof error.code === "string" && /^[A-Z0-9_-]{1,32}$/.test(error.code)
      ? ` (${error.code})`
      : "";
  console.error(`[campaigns] ${operation} failed${code}.`);
  res.status(500).json({ error: "Internal server error." });
}

router.use(ensureAuthenticated);

router.post("/", async (req: Request, res: Response) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthenticated." });

  const parsed = createCampaignSchema.safeParse(req.body);
  if (!parsed.success) return sendValidationError(res, parsed.error);

  try {
    const campaign = await prisma.emailCampaign.create({
      data: {
        userId,
        subject: parsed.data.subject,
        body: parsed.data.body,
        startTime: parsed.data.startTime ? new Date(parsed.data.startTime) : undefined,
        delayBetweenEmails: parsed.data.delayBetweenEmails,
        hourlyLimit: parsed.data.hourlyLimit ?? null,
      },
      select: {
        id: true,
        subject: true,
        body: true,
        startTime: true,
        delayBetweenEmails: true,
        hourlyLimit: true,
        status: true,
        createdAt: true,
        _count: { select: { recipients: true } },
      },
    });
    void indexCampaignSafely(campaign.id);
    return res.status(201).json({ ...campaign, recipientCount: campaign._count.recipients, _count: undefined });
  } catch (error) {
    return sendInternalError(res, "create", error);
  }
});

router.get("/", async (req: Request, res: Response) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthenticated." });

  try {
    const campaigns = await prisma.emailCampaign.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        subject: true,
        startTime: true,
        delayBetweenEmails: true,
        hourlyLimit: true,
        status: true,
        createdAt: true,
        _count: { select: { recipients: true } },
      },
    });

    if (campaigns.length === 0) return res.json([]);

    const counts = await prisma.emailRecipient.groupBy({
      by: ["campaignId", "status"],
      where: { campaignId: { in: campaigns.map((campaign) => campaign.id) } },
      _count: { _all: true },
    });
    const countsByCampaign = new Map<number, Record<RecipientStatus, number>>();
    for (const campaign of campaigns) {
      countsByCampaign.set(campaign.id, { PENDING: 0, QUEUED: 0, SENT: 0, FAILED: 0 });
    }
    for (const row of counts) {
      countsByCampaign.get(row.campaignId)![row.status] = row._count._all;
    }

    return res.json(
      campaigns.map(({ _count, ...campaign }) => ({
        ...campaign,
        recipientCount: _count.recipients,
        recipientCounts: countsByCampaign.get(campaign.id),
      }))
    );
  } catch (error) {
    return sendInternalError(res, "list", error);
  }
});

router.get("/:campaignId", async (req: Request, res: Response) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthenticated." });
  const campaignId = getCampaignId(req, res);
  if (!campaignId) return;

  try {
    const campaign = await prisma.emailCampaign.findFirst({
      where: { id: campaignId, userId },
      include: {
        recipients: {
          orderBy: { id: "asc" },
          select: {
            id: true,
            email: true,
            status: true,
            scheduledTime: true,
            sentTime: true,
            attemptCount: true,
            lastError: true,
          },
        },
      },
    });
    if (!campaign) return res.status(404).json({ error: "Campaign not found." });
    return res.json(campaign);
  } catch (error) {
    return sendInternalError(res, "get", error);
  }
});

router.post("/:campaignId/recipients", async (req: Request, res: Response) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthenticated." });
  const campaignId = getCampaignId(req, res);
  if (!campaignId) return;

  const parsed = addRecipientsSchema.safeParse(req.body);
  if (!parsed.success) return sendValidationError(res, parsed.error);

  try {
    const campaign = await prisma.emailCampaign.findFirst({
      where: { id: campaignId, userId },
      select: { id: true, status: true },
    });
    if (!campaign) return res.status(404).json({ error: "Campaign not found." });
    if (campaign.status !== CampaignStatus.DRAFT) {
      return res.status(400).json({ error: "Recipients can only be added to draft campaigns." });
    }

    const emails = [...new Set(parsed.data.emails.map((email) => email.trim().toLowerCase()))];
    const result = await prisma.emailRecipient.createMany({
      data: emails.map((email) => ({ campaignId, email })),
      skipDuplicates: true,
    });
    if (result.count > 0) {
      const insertedRecipients = await prisma.emailRecipient.findMany({
        where: { campaignId, email: { in: emails } },
        select: { id: true },
      });
      void indexRecipientDocumentsSafely(insertedRecipients.map((recipient) => recipient.id));
    }
    return res.status(201).json({
      campaignId,
      createdCount: result.count,
      duplicateCount: parsed.data.emails.length - result.count,
    });
  } catch (error) {
    return sendInternalError(res, "add recipients", error);
  }
});

router.post("/:campaignId/schedule", async (req: Request, res: Response) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthenticated." });
  const campaignId = getCampaignId(req, res);
  if (!campaignId) return;

  try {
    const campaign = await prisma.emailCampaign.findFirst({
      where: { id: campaignId, userId },
      select: { id: true, status: true },
    });
    if (!campaign) return res.status(404).json({ error: "Campaign not found." });
    const schedulableStatuses: CampaignStatus[] = [
      CampaignStatus.DRAFT,
      CampaignStatus.SCHEDULED,
      CampaignStatus.RUNNING,
    ];
    if (!schedulableStatuses.includes(campaign.status)) {
      return res.status(400).json({ error: "Campaign is not eligible for scheduling." });
    }

    const eligibleRecipients = await prisma.emailRecipient.count({
      where: {
        campaignId,
        OR: [
          { status: "PENDING" },
          { status: "QUEUED", scheduledTime: { not: null } },
        ],
      },
    });
    if (eligibleRecipients === 0) {
      return res.status(400).json({ error: "Campaign has no eligible recipients to schedule." });
    }

    const result = await scheduleCampaign(campaignId);
    const queuedRecipients = await prisma.emailRecipient.findMany({
      where: { campaignId, status: "QUEUED" },
      select: { id: true },
    });
    void indexCampaignSafely(campaignId);
    void indexRecipientDocumentsSafely(queuedRecipients.map((recipient) => recipient.id));
    const updatedCampaign = await prisma.emailCampaign.findFirst({
      where: { id: campaignId, userId },
      select: { status: true },
    });
    if (!updatedCampaign) return res.status(404).json({ error: "Campaign not found." });
    return res.json({ ...result, status: updatedCampaign.status });
  } catch (error) {
    return sendInternalError(res, "schedule", error);
  }
});

export default router;