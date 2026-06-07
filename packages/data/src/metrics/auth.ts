/**
 * Bearer-token gate for the data builder's /metrics endpoint. Mirrors the
 * api package's pattern verbatim — duplicated rather than shared via a
 * common package so each service stays self-contained and the auth policy
 * lives next to the scrape endpoint it protects.
 *
 * Rule, in order:
 *   1. METRICS_TOKEN set → require exactly that token.
 *   2. else open. The data builder has no API_KEY equivalent, so there's
 *      no fallback chain. Operators on a trusted internal network can leave
 *      it unset and rely on network isolation.
 *
 * Comparison is constant-time. A wrong-length token short-circuits the
 * loop but doesn't leak the right length back (response is identical to
 * "right length, wrong bytes").
 */

import type { MiddlewareHandler } from "hono";

const timingSafeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
};

export const metricsAuth = (
  metricsToken: string | undefined,
): MiddlewareHandler => {
  const effective = (metricsToken ?? "").trim();

  return async (c, next) => {
    if (!effective) {
      return next(); // open — trusted internal network
    }
    const header = (c.req.header("Authorization") ?? "").trim();
    if (!header.startsWith("Bearer ")) {
      return c.json(
        { error: "missing bearer token", code: "UNAUTHORIZED" },
        401,
      );
    }
    const provided = header.slice("Bearer ".length).trim();
    if (provided.length === 0 || !timingSafeEqual(provided, effective)) {
      return c.json(
        { error: "invalid token", code: "UNAUTHORIZED" },
        401,
      );
    }
    return next();
  };
};
