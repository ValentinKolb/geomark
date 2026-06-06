import type { Context, MiddlewareHandler } from "hono";
import { getConnInfo } from "hono/bun";

/**
 * In-memory **fixed-window** rate limiter, keyed by client IP.
 *
 * Single-process design — fine for v0.1 single-replica deployment. For
 * horizontal scaling, swap this for a Redis-backed limiter.
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

const WINDOW_MS = 60_000; // 1 minute fixed window
const SWEEP_INTERVAL_MS = 60_000;

const buckets = new Map<string, Bucket>();
let sweeper: ReturnType<typeof setInterval> | null = null;

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
    const cur = buckets.get(key);
    let bucket: Bucket;
    if (!cur || cur.resetAt <= now) {
      bucket = { count: 0, resetAt: now + WINDOW_MS };
      buckets.set(key, bucket);
    } else {
      bucket = cur;
    }
    bucket.count++;

    const remaining = Math.max(0, opts.limit - bucket.count);
    const resetSec = Math.ceil((bucket.resetAt - now) / 1000);
    c.header("X-RateLimit-Limit", String(opts.limit));
    c.header("X-RateLimit-Remaining", String(remaining));
    c.header("X-RateLimit-Reset", String(resetSec));

    if (bucket.count > opts.limit) {
      c.header("Retry-After", String(resetSec));
      return c.json(
        {
          error: `rate limit exceeded (${opts.limit}/min)`,
          code: "RATE_LIMIT",
        },
        429,
      );
    }
    await next();
  };
};

/** Test-only: reset all buckets. */
export const _resetRateLimitForTests = (): void => {
  buckets.clear();
};
