import { Request, Response, Router } from "express";
import { z } from "zod";
import {
  ElasticsearchUnavailableError,
  isElasticsearchConfigured,
  reindexUserDocuments,
  searchCampaignDocuments,
  searchRecipientDocuments,
} from "../services/elasticsearch";
import { ensureAuthenticated } from "./auth";

const router = Router();

const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(120).optional(),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
}).strict();

function getUserId(req: Request): number | undefined {
  const id = (req.user as { id?: unknown } | undefined)?.id;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

function getSearchParams(req: Request, res: Response) {
  const parsed = searchQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid search parameters." });
    return undefined;
  }
  return parsed.data;
}

function sendUnavailable(res: Response): void {
  res.status(503).json({ error: "Search service unavailable." });
}

router.use(ensureAuthenticated);

router.get("/campaigns", async (req: Request, res: Response) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthenticated." });
  const params = getSearchParams(req, res);
  if (!params) return;
  if (!isElasticsearchConfigured()) return sendUnavailable(res);

  try {
    return res.json(await searchCampaignDocuments(userId, params.q, params.page, params.pageSize));
  } catch (error) {
    if (error instanceof ElasticsearchUnavailableError) return sendUnavailable(res);
    console.error("[elasticsearch] Campaign search failed.");
    return res.status(500).json({ error: "Search failed." });
  }
});

router.get("/recipients", async (req: Request, res: Response) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthenticated." });
  const params = getSearchParams(req, res);
  if (!params) return;
  if (!isElasticsearchConfigured()) return sendUnavailable(res);

  try {
    return res.json(await searchRecipientDocuments(userId, params.q, params.page, params.pageSize));
  } catch (error) {
    if (error instanceof ElasticsearchUnavailableError) return sendUnavailable(res);
    console.error("[elasticsearch] Recipient search failed.");
    return res.status(500).json({ error: "Search failed." });
  }
});

router.post("/reindex", async (req: Request, res: Response) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ error: "Unauthenticated." });
  if (!isElasticsearchConfigured()) return sendUnavailable(res);

  try {
    return res.json(await reindexUserDocuments(userId));
  } catch (error) {
    if (error instanceof ElasticsearchUnavailableError) return sendUnavailable(res);
    console.error("[elasticsearch] User reindex failed.");
    return res.status(500).json({ error: "Reindex failed." });
  }
});

export default router;