import type { MetricsRegistry } from "./registry";

type CacheScope = "random" | "countries" | "coverage" | "generic";
type CacheResult = "hit" | "miss" | "write" | "bypass" | "error";
type RedisOperation = "read" | "write" | "ratelimit";
type RateLimitBackend = "redis" | "memory";
type RateLimitOutcome =
  | "allowed"
  | "rejected"
  | "fallback_allowed"
  | "fallback_rejected";

let current: MetricsRegistry | null = null;

export const installRuntimeMetrics = (metrics: MetricsRegistry): void => {
  current = metrics;
};

export const recordCacheEvent = (
  scope: CacheScope,
  result: CacheResult,
): void => {
  current?.cache.events.labels({ scope, result }).inc();
};

export const recordRedisError = (operation: RedisOperation): void => {
  current?.redisErrors.labels({ operation }).inc();
};

export const recordRateLimitCheck = (
  backend: RateLimitBackend,
  outcome: RateLimitOutcome,
): void => {
  current?.ratelimitChecks.labels({ backend, outcome }).inc();
};
