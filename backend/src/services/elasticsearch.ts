import { prisma } from "../utils/prisma";
import { env } from "../utils/env";

const CAMPAIGNS_INDEX = "reachinbox-campaigns-v1";
const RECIPIENTS_INDEX = "reachinbox-recipients-v1";
const INDEX_TIMEOUT_MS = 5000;
const REINDEX_BATCH_SIZE = 100;

export class ElasticsearchUnavailableError extends Error {
  constructor() {
    super("Elasticsearch is unavailable.");
    this.name = "ElasticsearchUnavailableError";
  }
}

export interface CampaignSearchDocument {
  userId: number;
  campaignId: number;
  subject: string;
  status: string;
  startTime: string;
  createdAt: string;
  delayBetweenEmails: number;
  hourlyLimit: number | null;
}

export interface RecipientSearchDocument {
  userId: number;
  campaignId: number;
  recipientId: number;
  email: string;
  status: string;
  scheduledTime: string | null;
  sentTime: string | null;
  createdAt: string;
}

export interface SearchPage<T> {
  total: number;
  page: number;
  pageSize: number;
  results: T[];
}

interface ElasticsearchSearchResponse<T> {
  hits?: {
    total?: number | { value?: number };
    hits?: Array<{ _source?: T }>;
  };
}

const ensuredIndices = new Set<string>();

export function isElasticsearchConfigured(): boolean {
  return Boolean(env.ELASTICSEARCH_URL);
}

function createHeaders(contentType = "application/json"): Headers {
  const headers = new Headers({ "content-type": contentType });
  if (env.ELASTICSEARCH_API_KEY) {
    headers.set("authorization", `ApiKey ${env.ELASTICSEARCH_API_KEY}`);
  }
  return headers;
}

function endpoint(path: string): string {
  if (!env.ELASTICSEARCH_URL) throw new ElasticsearchUnavailableError();
  return `${env.ELASTICSEARCH_URL.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

async function ensureIndex(index: string, fetcher: typeof fetch): Promise<void> {
  if (ensuredIndices.has(index)) return;
  const mappings = index === CAMPAIGNS_INDEX
    ? {
        userId: { type: "integer" },
        campaignId: { type: "integer" },
        subject: { type: "text", fields: { keyword: { type: "keyword" } } },
        status: { type: "keyword" },
        startTime: { type: "date" },
        createdAt: { type: "date" },
        delayBetweenEmails: { type: "integer" },
        hourlyLimit: { type: "integer" },
      }
    : {
        userId: { type: "integer" },
        campaignId: { type: "integer" },
        recipientId: { type: "integer" },
        email: { type: "keyword" },
        status: { type: "keyword" },
        scheduledTime: { type: "date" },
        sentTime: { type: "date" },
        createdAt: { type: "date" },
      };
  let response: Response;
  try {
    response = await fetcher(endpoint(index), {
      method: "PUT",
      headers: createHeaders(),
      body: JSON.stringify({ mappings: { properties: mappings } }),
      signal: AbortSignal.timeout(INDEX_TIMEOUT_MS),
    });
  } catch {
    throw new ElasticsearchUnavailableError();
  }
  if (!response.ok) {
    if (response.status !== 400) throw new ElasticsearchUnavailableError();
    let errorType = "";
    try {
      const payload = await response.json() as { error?: { type?: string } };
      errorType = payload.error?.type ?? "";
    } catch {
      throw new ElasticsearchUnavailableError();
    }
    if (errorType !== "resource_already_exists_exception") throw new ElasticsearchUnavailableError();
  }
  ensuredIndices.add(index);
}

async function putDocument(index: string, id: number, document: object, fetcher: typeof fetch): Promise<void> {
  await ensureIndex(index, fetcher);
  let response: Response;
  try {
    response = await fetcher(endpoint(`${index}/_doc/${id}`), {
      method: "PUT",
      headers: createHeaders(),
      body: JSON.stringify(document),
      signal: AbortSignal.timeout(INDEX_TIMEOUT_MS),
    });
  } catch {
    throw new ElasticsearchUnavailableError();
  }
  if (!response.ok) throw new ElasticsearchUnavailableError();
}

export async function indexCampaignDocument(
  document: CampaignSearchDocument,
  fetcher: typeof fetch = fetch
): Promise<void> {
  await putDocument(CAMPAIGNS_INDEX, document.campaignId, document, fetcher);
}

export async function indexRecipientDocument(
  document: RecipientSearchDocument,
  fetcher: typeof fetch = fetch
): Promise<void> {
  await putDocument(RECIPIENTS_INDEX, document.recipientId, document, fetcher);
}

export async function indexCampaignSafely(campaignId: number): Promise<void> {
  if (!isElasticsearchConfigured()) return;
  try {
    const campaign = await prisma.emailCampaign.findUnique({
      where: { id: campaignId },
      select: {
        id: true,
        userId: true,
        subject: true,
        status: true,
        startTime: true,
        createdAt: true,
        delayBetweenEmails: true,
        hourlyLimit: true,
      },
    });
    if (!campaign) return;
    await indexCampaignDocument({
      userId: campaign.userId,
      campaignId: campaign.id,
      subject: campaign.subject,
      status: campaign.status,
      startTime: campaign.startTime.toISOString(),
      createdAt: campaign.createdAt.toISOString(),
      delayBetweenEmails: campaign.delayBetweenEmails,
      hourlyLimit: campaign.hourlyLimit,
    });
  } catch {
    console.warn("[elasticsearch] Campaign indexing failed; PostgreSQL remains authoritative.");
  }
}

export async function indexRecipientSafely(recipientId: number): Promise<void> {
  if (!isElasticsearchConfigured()) return;
  try {
    const recipient = await prisma.emailRecipient.findUnique({
      where: { id: recipientId },
      select: {
        id: true,
        campaignId: true,
        email: true,
        status: true,
        scheduledTime: true,
        sentTime: true,
        createdAt: true,
        campaign: { select: { userId: true } },
      },
    });
    if (!recipient) return;
    await indexRecipientDocument({
      userId: recipient.campaign.userId,
      campaignId: recipient.campaignId,
      recipientId: recipient.id,
      email: recipient.email,
      status: recipient.status,
      scheduledTime: recipient.scheduledTime?.toISOString() ?? null,
      sentTime: recipient.sentTime?.toISOString() ?? null,
      createdAt: recipient.createdAt.toISOString(),
    });
  } catch {
    console.warn("[elasticsearch] Recipient indexing failed; PostgreSQL remains authoritative.");
  }
}

export async function indexRecipientDocumentsSafely(recipientIds: number[]): Promise<void> {
  if (!isElasticsearchConfigured() || recipientIds.length === 0) return;
  try {
    const recipients = await prisma.emailRecipient.findMany({
      where: { id: { in: recipientIds } },
      select: {
        id: true,
        campaignId: true,
        email: true,
        status: true,
        scheduledTime: true,
        sentTime: true,
        createdAt: true,
        campaign: { select: { userId: true } },
      },
    });
    const documents = recipients.map((recipient): RecipientSearchDocument => ({
      userId: recipient.campaign.userId,
      campaignId: recipient.campaignId,
      recipientId: recipient.id,
      email: recipient.email,
      status: recipient.status,
      scheduledTime: recipient.scheduledTime?.toISOString() ?? null,
      sentTime: recipient.sentTime?.toISOString() ?? null,
      createdAt: recipient.createdAt.toISOString(),
    }));
    if (documents.length === 0) return;

    await ensureIndex(RECIPIENTS_INDEX, fetch);
    const ndjson = documents.flatMap((document) => [
      JSON.stringify({ index: { _index: RECIPIENTS_INDEX, _id: document.recipientId } }),
      JSON.stringify(document),
    ]).join("\n") + "\n";
    const response = await fetch(endpoint(`${RECIPIENTS_INDEX}/_bulk`), {
      method: "POST",
      headers: createHeaders("application/x-ndjson"),
      body: ndjson,
      signal: AbortSignal.timeout(INDEX_TIMEOUT_MS),
    });
    if (!response.ok) throw new ElasticsearchUnavailableError();
    const result = await response.json() as { errors?: boolean };
    if (result.errors) throw new ElasticsearchUnavailableError();
  } catch {
    console.warn("[elasticsearch] Recipient batch indexing failed; PostgreSQL remains authoritative.");
  }
}

function makeSearchQuery(userId: number, query: string | undefined, fields: string[]): object {
  const userFilter = { term: { userId } };
  if (!query) return { bool: { filter: [userFilter] } };
  return {
    bool: {
      filter: [userFilter],
      must: [{ multi_match: { query, fields, type: "best_fields" } }],
    },
  };
}

async function searchIndex<T>(
  index: string,
  userId: number,
  query: string | undefined,
  page: number,
  pageSize: number,
  searchFields: string[],
  sourceFields: string[],
  fetcher: typeof fetch
): Promise<SearchPage<T>> {
  let response: Response;
  try {
    response = await fetcher(endpoint(`${index}/_search`), {
      method: "POST",
      headers: createHeaders(),
      body: JSON.stringify({
        from: (page - 1) * pageSize,
        size: pageSize,
        track_total_hits: true,
        _source: sourceFields,
        query: makeSearchQuery(userId, query, searchFields),
        sort: [{ _score: "desc" }, { _id: "asc" }],
      }),
      signal: AbortSignal.timeout(INDEX_TIMEOUT_MS),
    });
  } catch {
    throw new ElasticsearchUnavailableError();
  }
  if (response.status === 404) return { total: 0, page, pageSize, results: [] };
  if (!response.ok) throw new ElasticsearchUnavailableError();

  let payload: ElasticsearchSearchResponse<T>;
  try {
    payload = await response.json() as ElasticsearchSearchResponse<T>;
  } catch {
    throw new ElasticsearchUnavailableError();
  }
  const total = typeof payload.hits?.total === "number"
    ? payload.hits.total
    : payload.hits?.total?.value ?? 0;
  return {
    total,
    page,
    pageSize,
    results: (payload.hits?.hits ?? []).flatMap((hit) => hit._source ? [hit._source] : []),
  };
}

export function searchCampaignDocuments(
  userId: number,
  query: string | undefined,
  page: number,
  pageSize: number,
  fetcher: typeof fetch = fetch
): Promise<SearchPage<CampaignSearchDocument>> {
  return searchIndex(
    CAMPAIGNS_INDEX,
    userId,
    query,
    page,
    pageSize,
    ["subject", "status"],
    ["userId", "campaignId", "subject", "status", "startTime", "createdAt", "delayBetweenEmails", "hourlyLimit"],
    fetcher
  );
}

export function searchRecipientDocuments(
  userId: number,
  query: string | undefined,
  page: number,
  pageSize: number,
  fetcher: typeof fetch = fetch
): Promise<SearchPage<RecipientSearchDocument>> {
  return searchIndex(
    RECIPIENTS_INDEX,
    userId,
    query,
    page,
    pageSize,
    ["email", "status"],
    ["userId", "campaignId", "recipientId", "email", "status", "scheduledTime", "sentTime", "createdAt"],
    fetcher
  );
}

export async function reindexUserDocuments(userId: number): Promise<{ campaigns: number; recipients: number }> {
  if (!isElasticsearchConfigured()) throw new ElasticsearchUnavailableError();
  let campaigns = 0;
  let recipients = 0;
  let campaignCursor: number | undefined;
  while (true) {
    const batch = await prisma.emailCampaign.findMany({
      where: { userId },
      orderBy: { id: "asc" },
      take: REINDEX_BATCH_SIZE,
      ...(campaignCursor === undefined ? {} : { cursor: { id: campaignCursor }, skip: 1 }),
      select: {
        id: true,
        userId: true,
        subject: true,
        status: true,
        startTime: true,
        createdAt: true,
        delayBetweenEmails: true,
        hourlyLimit: true,
      },
    });
    if (batch.length === 0) break;
    for (const campaign of batch) {
      await indexCampaignDocument({
        userId: campaign.userId,
        campaignId: campaign.id,
        subject: campaign.subject,
        status: campaign.status,
        startTime: campaign.startTime.toISOString(),
        createdAt: campaign.createdAt.toISOString(),
        delayBetweenEmails: campaign.delayBetweenEmails,
        hourlyLimit: campaign.hourlyLimit,
      });
      campaigns++;
    }
    campaignCursor = batch[batch.length - 1].id;
  }

  let recipientCursor: number | undefined;
  while (true) {
    const batch = await prisma.emailRecipient.findMany({
      where: { campaign: { userId } },
      orderBy: { id: "asc" },
      take: REINDEX_BATCH_SIZE,
      ...(recipientCursor === undefined ? {} : { cursor: { id: recipientCursor }, skip: 1 }),
      select: {
        id: true,
        campaignId: true,
        email: true,
        status: true,
        scheduledTime: true,
        sentTime: true,
        createdAt: true,
      },
    });
    if (batch.length === 0) break;
    for (const recipient of batch) {
      await indexRecipientDocument({
        userId,
        campaignId: recipient.campaignId,
        recipientId: recipient.id,
        email: recipient.email,
        status: recipient.status,
        scheduledTime: recipient.scheduledTime?.toISOString() ?? null,
        sentTime: recipient.sentTime?.toISOString() ?? null,
        createdAt: recipient.createdAt.toISOString(),
      });
      recipients++;
    }
    recipientCursor = batch[batch.length - 1].id;
  }
  return { campaigns, recipients };
}

export const elasticsearchTestInternals = {
  makeSearchQuery,
  clearEnsuredIndices: () => ensuredIndices.clear(),
};