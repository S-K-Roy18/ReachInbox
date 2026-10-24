import assert from "node:assert/strict";

interface CapturedCall {
  url: string;
  init?: RequestInit;
}

async function runElasticsearchTests(): Promise<void> {
  process.env.ELASTICSEARCH_URL = "http://mock-elasticsearch.invalid";
  const {
    ElasticsearchUnavailableError,
    elasticsearchTestInternals,
    indexCampaignDocument,
    indexRecipientDocument,
    searchCampaignDocuments,
    searchRecipientDocuments,
  } = await import("./src/services/elasticsearch");
  elasticsearchTestInternals.clearEnsuredIndices();
  const calls: CapturedCall[] = [];
  const mockFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/_search")) {
      return new Response(JSON.stringify({
        hits: {
          total: { value: 1 },
          hits: [{ _source: { userId: 71, campaignId: 41, subject: "Quarterly update", status: "DRAFT" } }],
        },
      }), { status: 200 });
    }
    if (url.includes("/_doc/")) return new Response("{}", { status: 201 });
    return new Response("{}", { status: 200 });
  };

  const campaign = {
    userId: 71,
    campaignId: 41,
    subject: "Quarterly update",
    status: "DRAFT",
    startTime: "2026-10-24T00:00:00.000Z",
    createdAt: "2026-10-24T00:00:00.000Z",
    delayBetweenEmails: 2,
    hourlyLimit: 100,
  };
  const recipient = {
    userId: 71,
    campaignId: 41,
    recipientId: 99,
    email: "person@example.invalid",
    status: "PENDING",
    scheduledTime: null,
    sentTime: null,
    createdAt: "2026-10-24T00:00:00.000Z",
  };

  await indexCampaignDocument(campaign, mockFetch);
  await indexCampaignDocument(campaign, mockFetch);
  await indexRecipientDocument(recipient, mockFetch);

  const campaignDocCalls = calls.filter((call) => call.url.endsWith("/reachinbox-campaigns-v1/_doc/41"));
  const recipientDocCalls = calls.filter((call) => call.url.endsWith("/reachinbox-recipients-v1/_doc/99"));
  assert.equal(campaignDocCalls.length, 2, "repeated indexing should use the same campaign document ID");
  assert.equal(recipientDocCalls.length, 1, "recipient indexing should use its stable recipient ID");
  const indexedBodies = [...campaignDocCalls, ...recipientDocCalls].map((call) => String(call.init?.body));
  assert(indexedBodies.every((body) => !body.includes("body") && !body.includes("token") && !body.includes("password")));
  const campaignMapping = calls.find((call) => call.url.endsWith("/reachinbox-campaigns-v1"));
  assert(campaignMapping);
  const mappingBody = String(campaignMapping.init?.body);
  assert(!mappingBody.includes("emailBody") && !mappingBody.includes("slackAccessToken"));

  const campaignPage = await searchCampaignDocuments(71, "quarterly", 2, 10, mockFetch);
  assert.equal(campaignPage.total, 1);
  assert.equal(campaignPage.page, 2);
  assert.equal(campaignPage.pageSize, 10);
  assert.equal(campaignPage.results[0].campaignId, 41);
  const campaignSearch = calls.filter((call) => call.url.endsWith("/reachinbox-campaigns-v1/_search")).at(-1)!;
  const campaignSearchBody = JSON.parse(String(campaignSearch.init?.body));
  assert.equal(campaignSearchBody.from, 10);
  assert.equal(campaignSearchBody.size, 10);
  assert.deepEqual(campaignSearchBody._source, ["userId", "campaignId", "subject", "status", "startTime", "createdAt", "delayBetweenEmails", "hourlyLimit"]);
  assert.deepEqual(campaignSearchBody.query.bool.filter, [{ term: { userId: 71 } }]);
  assert.equal(campaignSearchBody.query.bool.must[0].multi_match.query, "quarterly");

  await searchRecipientDocuments(83, "example.invalid", 1, 5, mockFetch);
  const recipientSearch = calls.filter((call) => call.url.endsWith("/reachinbox-recipients-v1/_search")).at(-1)!;
  const recipientSearchBody = JSON.parse(String(recipientSearch.init?.body));
  assert.deepEqual(recipientSearchBody.query.bool.filter, [{ term: { userId: 83 } }]);
  assert.equal(recipientSearchBody.size, 5);
  assert.deepEqual(recipientSearchBody._source, ["userId", "campaignId", "recipientId", "email", "status", "scheduledTime", "sentTime", "createdAt"]);

  const offlineFetch: typeof fetch = async () => {
    throw new Error("mock Elasticsearch offline");
  };
  await assert.rejects(
    searchCampaignDocuments(71, undefined, 1, 20, offlineFetch),
    (error: unknown) => error instanceof ElasticsearchUnavailableError
  );
  await assert.rejects(
    indexRecipientDocument(recipient, offlineFetch),
    (error: unknown) => error instanceof ElasticsearchUnavailableError
  );

  console.log("Elasticsearch tests passed: stable IDs, safe mappings/documents, owner filters, pagination, and outage errors.");
}

runElasticsearchTests().catch((error) => {
  console.error("Elasticsearch tests failed.");
  if (error instanceof Error) console.error(error.message);
  process.exitCode = 1;
});