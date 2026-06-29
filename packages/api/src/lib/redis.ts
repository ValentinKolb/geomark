import { RedisClient } from "bun";
import { config } from "../config";
import { recordCacheEvent, recordRedisError } from "../metrics/runtime";

let client: RedisClient | null | undefined;
let cacheDisabledUntil = 0;
let lastCacheWarning = 0;

const CACHE_BACKOFF_MS = 30_000;

export const redisConfigured = (): boolean => config.redisUrl !== undefined;

export const getRedis = (): RedisClient | null => {
  if (!config.redisUrl) return null;
  if (client === undefined) {
    client = new RedisClient(config.redisUrl);
  }
  return client;
};

export const closeRedis = (): void => {
  client?.close();
  client = null;
};

const markCacheFailure = (operation: string, err: unknown): void => {
  const now = Date.now();
  cacheDisabledUntil = now + CACHE_BACKOFF_MS;
  if (now - lastCacheWarning < CACHE_BACKOFF_MS) return;
  lastCacheWarning = now;
  console.warn(`[redis] cache ${operation} failed; bypassing briefly:`, err);
};

type CacheScope = "random" | "countries" | "coverage" | "generic";

export const cacheGetJson = async <T>(
  key: string,
  scope: CacheScope = "generic",
): Promise<T | null> => {
  if (Date.now() < cacheDisabledUntil) {
    recordCacheEvent(scope, "bypass");
    return null;
  }
  const r = getRedis();
  if (!r) {
    recordCacheEvent(scope, "bypass");
    return null;
  }
  try {
    const raw = await r.get(key);
    if (raw === null) {
      recordCacheEvent(scope, "miss");
      return null;
    }
    recordCacheEvent(scope, "hit");
    return JSON.parse(raw) as T;
  } catch (err) {
    recordCacheEvent(scope, "error");
    recordRedisError("read");
    markCacheFailure("read", err);
    return null;
  }
};

export const cacheSetJson = async (
  key: string,
  value: unknown,
  ttlSeconds: number,
  scope: CacheScope = "generic",
): Promise<void> => {
  if (ttlSeconds <= 0) {
    recordCacheEvent(scope, "bypass");
    return;
  }
  if (Date.now() < cacheDisabledUntil) {
    recordCacheEvent(scope, "bypass");
    return;
  }
  const r = getRedis();
  if (!r) {
    recordCacheEvent(scope, "bypass");
    return;
  }
  try {
    await r.setex(key, ttlSeconds, JSON.stringify(value));
    recordCacheEvent(scope, "write");
  } catch (err) {
    recordCacheEvent(scope, "error");
    recordRedisError("write");
    markCacheFailure("write", err);
  }
};
