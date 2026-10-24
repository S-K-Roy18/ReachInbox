import assert from "node:assert/strict";
import {
  decryptSlackToken,
  encryptSlackToken,
  isSlackTestNotificationEnabled,
  isValidSlackOAuthState,
  postSlackHourlyLimitNotification,
  postSlackTestNotification,
  SlackIntegrationError,
  SlackOAuthState,
  toSlackConnectionStatus,
} from "./src/services/slackIntegration";

async function runSlackTests(): Promise<void> {
  const now = Date.now();
  const state: SlackOAuthState = { value: "random-state-value", userId: 41, createdAt: now };
  assert.equal(isValidSlackOAuthState(state, state.value, 41, now), true);
  assert.equal(isValidSlackOAuthState(state, "wrong-state", 41, now), false);
  assert.equal(isValidSlackOAuthState(state, state.value, 42, now), false);
  assert.equal(isValidSlackOAuthState(state, state.value, 41, now + 10 * 60 * 1000 + 1), false);
  assert.equal(isValidSlackOAuthState(undefined, state.value, 41, now), false, "consumed state cannot be reused");
  assert.equal(isSlackTestNotificationEnabled("development"), true);
  assert.equal(isSlackTestNotificationEnabled("production"), false);
  assert.equal(isSlackTestNotificationEnabled("test"), false);

  const token = "xoxb-private-test-token";
  const testKey = "a".repeat(64);
  const encryptedToken = encryptSlackToken(token, testKey);
  assert(!encryptedToken.includes(token), "stored token ciphertext must not contain the plaintext token");
  assert.equal(decryptSlackToken(encryptedToken, testKey), token);

  const status = toSlackConnectionStatus({
    slackAccessTokenEncrypted: encryptedToken,
    slackUserId: "U_TEST",
    slackTeamId: "T_TEST",
    slackConnectedAt: new Date(now),
  });
  assert.equal(status.connected, true);
  assert.equal("accessToken" in status, false);
  assert.equal("slackAccessTokenEncrypted" in status, false);

  let requestedBody = "";
  const mockSuccess: typeof fetch = async (_input, init) => {
    requestedBody = String(init?.body ?? "");
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  await postSlackHourlyLimitNotification(token, "U_TEST", 123, 10, mockSuccess);
  assert(requestedBody.includes('"channel":"U_TEST"'));
  assert(requestedBody.includes('"text":"Campaign 123 reached its rolling hourly limit of 10 emails. Remaining messages are queued until capacity is available."'));
  assert(!requestedBody.includes(token));

  requestedBody = "";
  await postSlackTestNotification(token, "U_TEST", mockSuccess);
  assert(requestedBody.includes('"channel":"U_TEST"'));
  assert(requestedBody.includes("ReachInbox test notification"));
  assert(!requestedBody.includes(token));

  const mockRejected: typeof fetch = async () =>
    new Response(JSON.stringify({ ok: false, error: "invalid_auth" }), { status: 200 });
  await assert.rejects(
    postSlackHourlyLimitNotification(token, "U_TEST", 123, 10, mockRejected),
    (error: unknown) => {
      assert(error instanceof SlackIntegrationError);
      assert.equal(error.stage, "notification");
      assert.equal(error.code, "SLACK_REJECTED");
      assert(!error.message.includes(token));
      assert(!error.message.includes("invalid_auth"));
      return true;
    }
  );

  const mockNetworkFailure: typeof fetch = async () => {
    throw new Error("private token and request content must not be surfaced");
  };
  await assert.rejects(
    postSlackHourlyLimitNotification(token, "U_TEST", 123, 10, mockNetworkFailure),
    (error: unknown) => {
      assert(error instanceof SlackIntegrationError);
      assert.equal(error.code, "NETWORK_ERROR");
      assert(!error.message.includes(token));
      return true;
    }
  );

  await assert.rejects(
    postSlackTestNotification(token, "U_TEST", mockRejected),
    (error: unknown) => error instanceof SlackIntegrationError && error.code === "SLACK_REJECTED"
  );

  console.log("Slack tests passed: OAuth state, encrypted-token privacy, notification payload, and safe Slack errors.");
}

runSlackTests().catch((error) => {
  console.error("Slack tests failed.");
  if (error instanceof Error) console.error(error.message);
  process.exitCode = 1;
});