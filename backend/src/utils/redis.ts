
import Redis from "ioredis";
import { ConnectionOptions } from "bullmq";
import { env } from "./env";

const redisUrl = process.env.REDIS_URL;

export const redisConnectionOptions: ConnectionOptions = redisUrl
  ? {
      // Hosted Redis (Upstash) using a rediss:// URL with TLS
      ...(() => {
        const parsed = new URL(redisUrl);

        return {
          host: parsed.hostname,
          port: Number(parsed.port || 6379),
          username: parsed.username
            ? decodeURIComponent(parsed.username)
            : undefined,
          password: parsed.password
            ? decodeURIComponent(parsed.password)
            : undefined,
          tls: parsed.protocol === "rediss:" ? {} : undefined,
        };
      })(),
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    }
  : {
      // Local Docker Redis
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

export const closeRedisClient = async (): Promise<void> => {
  const client = redisClient;
  redisClient = null;
  if (client) await client.quit();
};
