// backend/src/utils/redis.ts
import Redis, { RedisOptions } from "ioredis";
import { env } from "./env";

export const redisConnectionOptions: RedisOptions = {
  host: env.REDIS_HOST,
  port: Number(env.REDIS_PORT),
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
};

let redisClient: Redis | null = null;

export const getRedisClient = (): Redis => {
  if (!redisClient) {
    redisClient = new Redis(redisConnectionOptions);

    redisClient.on("error", (err) => {
      console.error("[redis] Connection error:", err.message);
    });

    redisClient.on("connect", () => {
      console.log("[redis] Connected to Redis successfully");
    });
  }

  return redisClient;
};
