/**
 * Layered bearer-token gate for /metrics, mirroring filegate's pattern.
 *
 * Rule, in order:
 *   1. METRICS_TOKEN set → require exactly that token.
 *   2. else API_KEY set → reuse the general API key as the metrics token.
 *      Operators who already protect the public API with an API_KEY get
 *      protected /metrics for free with no extra config.
 *   3. else open. Intentional: operators on a trusted internal network
 *      where Prometheus holds no Geomark credentials can leave both
 *      unset and rely on network isolation.
 *
 * The comparison is constant-time. A wrong-length token short-circuits
 * the loop but doesn't leak the right length back to a probing client
 * because the response is identical to "right length, wrong bytes".
 */

import type { MiddlewareHandler } from "hono";

/**
 * Constant-time string compare. Returns false immediately on
 * length-mismatch (length itself isn't secret — the value is), and
 * otherwise XORs every byte so the loop's runtime is constant for
 * same-length inputs.
 */
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
  apiKeyFallback: string | undefined,
): MiddlewareHandler => {
  const explicit = (metricsToken ?? "").trim();
  const fallback = (apiKeyFallback ?? "").trim();
  const effective = explicit || fallback;

  return async (c, next) => {
    if (!effective) {
      // Open mode — no credential configured. Filegate calls this the
      // "trusted internal network" case; same intent here.
      return next();
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
