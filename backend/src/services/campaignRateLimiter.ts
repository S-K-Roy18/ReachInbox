import { getRedisClient } from "../utils/redis";

const RATE_LIMIT_KEY_PREFIX = "reachinbox:campaign-send-slots:";
const RATE_LIMIT_NOTIFICATION_PREFIX = "reachinbox:campaign-hourly-notified:";

const reserveSendSlotScript = `
local key = KEYS[1]
local notificationKey = KEYS[2]
local token = ARGV[1]
local hourlyLimit = tonumber(ARGV[2])
local minimumDelayMs = tonumber(ARGV[3])
local now

if ARGV[4] ~= '' then
  now = tonumber(ARGV[4])
else
  local redisTime = redis.call('TIME')
  now = tonumber(redisTime[1]) * 1000 + math.floor(tonumber(redisTime[2]) / 1000)
end

local existingScore = redis.call('ZSCORE', key, token)
if existingScore then
  local existingTime = tonumber(existingScore)
  if existingTime > now then
    return { 0, existingTime, existingTime - now, 0 }
  end
  return { 1, existingTime, 0, 0 }
end

redis.call('ZREMRANGEBYSCORE', key, '-inf', now - 3600000)

local candidate = now
local notificationDue = 0
if minimumDelayMs > 0 then
  local latest = redis.call('ZREVRANGE', key, 0, 0, 'WITHSCORES')
  if #latest > 0 then
    candidate = math.max(candidate, tonumber(latest[2]) + minimumDelayMs)
  end
end

if hourlyLimit > 0 then
  while true do
    local windowStart = candidate - 3600000
    local count = redis.call('ZCOUNT', key, '(' .. windowStart, candidate)
    if count < hourlyLimit then
      break
    end

    if notificationDue == 0 then
      local claimed = redis.call('SET', notificationKey, '1', 'NX', 'PX', 3600000)
      if claimed then
        notificationDue = 1
      end
    end

    local oldest = redis.call('ZRANGEBYSCORE', key, '(' .. windowStart, candidate, 'WITHSCORES', 'LIMIT', 0, 1)
    if #oldest == 0 then
      break
    end
    candidate = math.max(candidate, tonumber(oldest[2]) + 3600000)
  end
end

redis.call('ZADD', key, candidate, token)
redis.call('PEXPIRE', key, math.max(3600000, candidate - now + 3600000))

if candidate > now then
  return { 0, candidate, candidate - now, notificationDue }
end
return { 1, candidate, 0, notificationDue }
`;

export interface SendSlotReservation {
  allowed: boolean;
  scheduledAt: number;
  delayMs: number;
  notificationDue: boolean;
}

export class RateLimitReservationError extends Error {
  readonly code = "RATE_LIMIT_RESERVATION_FAILED";

  constructor() {
    super("Campaign rate-limit reservation failed.");
    this.name = "RateLimitReservationError";
  }
}

export function getCampaignRateLimitKey(campaignId: number | string): string {
  return `${RATE_LIMIT_KEY_PREFIX}${campaignId}`;
}

export function getCampaignRateLimitNotificationKey(campaignId: number | string): string {
  return `${RATE_LIMIT_NOTIFICATION_PREFIX}${campaignId}`;
}

export async function reserveCampaignSendSlot(
  campaignId: number | string,
  attemptToken: string,
  hourlyLimit: number | null,
  minimumDelaySeconds: number,
  nowForTest?: number
): Promise<SendSlotReservation> {
  try {
    const result = await getRedisClient().eval(
      reserveSendSlotScript,
      2,
      getCampaignRateLimitKey(campaignId),
      getCampaignRateLimitNotificationKey(campaignId),
      attemptToken,
      hourlyLimit ?? 0,
      Math.max(0, minimumDelaySeconds) * 1000,
      nowForTest ?? ""
    ) as [number | string, number | string, number | string, number | string];

    return {
      allowed: Number(result[0]) === 1,
      scheduledAt: Number(result[1]),
      delayMs: Number(result[2]),
      notificationDue: Number(result[3]) === 1,
    };
  } catch {
    throw new RateLimitReservationError();
  }
}