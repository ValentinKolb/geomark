import type { Context, MiddlewareHandler } from "hono";
import { getConnInfo } from "hono/bun";
import { ratelimit as createSyncRateLimit } from "@valentinkolb/sync";
import { redisConfigured } from "./redis";
import { recordRateLimitCheck, recordRedisError } from "../metrics/runtime";

/**
 * Per-IP rate limiter.
 *
 * Redis-backed when REDIS_URL is configured, with an in-memory fallback when
 * Redis is unavailable. The fallback is intentionally single-process and only
 * protects the API while Redis recovers; production compose wires Redis by
 * default so multiple API replicas share the same buckets.
 *
 * IP resolution honors `X-Forwarded-For` based on a configurable trusted
 * proxy depth (`trustedProxyHops`):
 *   0 → ignore XFF, use the socket peer
 *   N → take `XFF.at(-N)` (the entry written by the closest trusted proxy)
 *
 * The proxy chain MUST strip any client-supplied XFF header before
 * appending. Traefik does this by default; nginx requires explicit
 * `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`.
 */

type Bucket = { count: number; resetAt: number };
type LimitState = { count: number; remaining: number; resetMs: number };

const WINDOW_MS = 60_000;
const SWEEP_INTERVAL_MS = 60_000;
const REDIS_BACKOFF_MS = 30_000;

const buckets = new Map<string, Bucket>();
let sweeper: ReturnType<typeof setInterval> | null = null;
let redisDisabledUntil = 0;
let lastRedisWarning = 0;

const ensureSweeper = (): void => {
  if (sweeper !== null) return;
  sweeper = setInterval(() => {
    const now = Date.now();
    for (const [k, b] of buckets) {
      if (b.resetAt <= now) buckets.delete(k);
    }
  }, SWEEP_INTERVAL_MS);
  sweeper.unref?.();
};

const clientKey = (c: Context, trustedProxyHops: number): string => {
  if (trustedProxyHops > 0) {
    const xff = c.req.header("x-forwarded-for");
    if (xff) {
      const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
      if (parts.length >= trustedProxyHops) {
        return parts.at(-trustedProxyHops)!;
      }
    }
  }
  // Bun's Hono adapter exposes peer address via getConnInfo (hono/bun).
  try {
    const info = getConnInfo(c);
    if (info.remote.address) return info.remote.address;
  } catch {
    // Not running on Bun — happens in some test contexts.
  }
  return "unknown";
};

const memoryCheck = (key: string, limit: number, now: number): LimitState => {
  const cur = buckets.get(key);
  let bucket: Bucket;
  if (!cur || cur.resetAt <= now) {
    bucket = { count: 0, resetAt: now + WINDOW_MS };
    buckets.set(key, bucket);
  } else {
    bucket = cur;
  }
  bucket.count++;
  return {
    count: bucket.count,
    remaining: Math.max(0, limit - bucket.count),
    resetMs: Math.max(0, bucket.resetAt - now),
  };
};

const syncLimiters = new Map<
  number,
  ReturnType<typeof createSyncRateLimit>
>();

const getSyncLimiter = (limit: number): ReturnType<typeof createSyncRateLimit> => {
  const existing = syncLimiters.get(limit);
  if (existing) return existing;
  const limiter = createSyncRateLimit({
    id: "api",
    limit,
    windowSecs: WINDOW_MS / 1000,
    prefix: "geomark:ratelimit",
  });
  syncLimiters.set(limit, limiter);
  return limiter;
};

const syncCheck = async (
  key: string,
  limit: number,
): Promise<LimitState> => {
  const result = await getSyncLimiter(limit).check(key);
  return {
    count: result.limited ? limit + 1 : limit - result.remaining,
    remaining: result.remaining,
    resetMs: result.resetIn,
  };
};

const warnRedisFallback = (err: unknown): void => {
  const now = Date.now();
  if (now - lastRedisWarning < REDIS_BACKOFF_MS) return;
  lastRedisWarning = now;
  console.warn("[rateLimit] Redis unavailable; using in-memory fallback:", err);
};

type RateLimitOptions = {
  /** Requests per minute per client. */
  limit: number;
  /** See config.trustedProxyHops. */
  trustedProxyHops: number;
};

export const rateLimit = (opts: RateLimitOptions): MiddlewareHandler => {
  ensureSweeper();
  return async (c, next) => {
    const key = clientKey(c, opts.trustedProxyHops);
    const now = Date.now();
    let state: LimitState;
    let backend: "redis" | "memory" = "memory";
    let fallback = false;
    if (redisConfigured() && now >= redisDisabledUntil) {
      try {
        state = await syncCheck(key, opts.limit);
        backend = "redis";
      } catch (err) {
        redisDisabledUntil = now + REDIS_BACKOFF_MS;
        recordRedisError("ratelimit");
        warnRedisFallback(err);
        state = memoryCheck(key, opts.limit, now);
        fallback = true;
      }
    } else {
      state = memoryCheck(key, opts.limit, now);
    }

    const resetSec = Math.max(1, Math.ceil(state.resetMs / 1000));
    c.header("X-RateLimit-Limit", String(opts.limit));
    c.header("X-RateLimit-Remaining", String(state.remaining));
    c.header("X-RateLimit-Reset", String(resetSec));

    if (state.count > opts.limit) {
      recordRateLimitCheck(
        backend,
        fallback ? "fallback_rejected" : "rejected",
      );
      c.header("Retry-After", String(resetSec));
      return c.json(
        {
          error: `rate limit exceeded (${opts.limit}/min)`,
          code: "RATE_LIMIT",
        },
        429,
      );
    }
    recordRateLimitCheck(backend, fallback ? "fallback_allowed" : "allowed");
    await next();
  };
};

/** Test-only: reset all buckets. */
export const _resetRateLimitForTests = (): void => {
  buckets.clear();
  syncLimiters.clear();
};
