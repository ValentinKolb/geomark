/**
 * HTTP RED middleware: records request rate, error rate (via status
 * class), and request duration for every matched route.
 *
 * The middleware is mounted on the OUTER app at `/v1/*` (and any
 * other path you want instrumented). It runs around the v1 sub-app —
 * including its rate-limit and bearer-auth layers — so 429s from the
 * limiter and 401s from the auth gate are visible in the same series.
 *
 * The `route` label is the matched template (`/v1/place/:gid`,
 * normalized to OpenAPI-style `/v1/place/{gid}`), NOT the actual
 * URL. That keeps cardinality at the small fixed set of registered
 * routes — about a dozen for Geomark — instead of one series per GID.
 */

import type { MiddlewareHandler } from "hono";
import type { MetricsRegistry } from "./registry";

/** Bucket an HTTP status code into a small fixed label set. */
const statusClass = (code: number): string => {
  if (code >= 200 && code < 300) return "2xx";
  if (code >= 300 && code < 400) return "3xx";
  if (code >= 400 && code < 500) return "4xx";
  if (code >= 500 && code < 600) return "5xx";
  if (code >= 100 && code < 200) return "1xx";
  return "other";
};

/**
 * Normalize Hono's `:param` route template to OpenAPI-style `{param}`,
 * so dashboards built off the OpenAPI spec and the metrics share labels.
 * Also collapses unmatched / wildcard catch-alls to a single bucket so a
 * 404-storm can't bloat the series count.
 */
const normalizeRoute = (raw: string | undefined): string => {
  if (!raw) return "unmatched";
  // Hono returns "/*" for an unmatched-but-middleware-wrapped path.
  if (raw === "/*" || raw === "*") return "unmatched";
  return raw.replace(/:([A-Za-z_][\w]*)/g, "{$1}");
};

/**
 * Classify a 401 by how the client failed. Mirrors the bearerAuth
 * middleware's own decision tree so the metric labels stay aligned
 * with the responses the user actually saw.
 */
const authRejectionReason = (authHeader: string | undefined): "missing" | "malformed" | "invalid" => {
  if (!authHeader) return "missing";
  if (!authHeader.startsWith("Bearer ")) return "malformed";
  return "invalid";
};

export const metricsMiddleware = (m: MetricsRegistry): MiddlewareHandler => {
  return async (c, next) => {
    const start = performance.now();
    m.http.inFlight.inc();
    try {
      await next();
    } finally {
      m.http.inFlight.dec();

      const route = normalizeRoute(c.req.routePath);
      const dur = (performance.now() - start) / 1000;
      // c.res can be undefined on a thrown error before any response was
      // written; default to 500 in that case so the failure still counts.
      const status = c.res?.status ?? 500;
      const cls = statusClass(status);

      m.http.requests.labels({ route, status_class: cls }).inc();
      m.http.duration.labels({ route }).observe(dur);

      // Infer rejection reasons from status + headers — no need to wrap
      // the rate-limit / bearer-auth middlewares to count their work.
      // Hono's bearerAuth returns 401 for missing / invalid tokens but 400
      // for a non-Bearer Authorization scheme (RFC 6750 §3.1). Both
      // failure modes count as auth rejections; only the 400 case is
      // discriminated by the presence of a non-Bearer header so we don't
      // accidentally count query-validation 400s here.
      const authHeader = c.req.header("Authorization");
      if (status === 429) {
        m.ratelimitRejected.inc();
      } else if (status === 401) {
        m.authRejected.labels({ reason: authRejectionReason(authHeader) }).inc();
      } else if (status === 400 && authHeader && !authHeader.startsWith("Bearer ")) {
        m.authRejected.labels({ reason: "malformed" }).inc();
      }
    }
  };
};
