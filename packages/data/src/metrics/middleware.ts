/**
 * HTTP RED middleware for the data builder's file server. Mirrors the api
 * package's middleware but instruments the bundle-download routes and also
 * counts bytes served per filename (egress tracking).
 *
 * Mounted on the outer app at "/v1/*" — root ops endpoints (/health,
 * /metrics) are deliberately not instrumented so scrape traffic doesn't
 * skew the file-server metrics.
 */

import type { MiddlewareHandler } from "hono";
import type { DataMetricsRegistry } from "./registry";

const statusClass = (code: number): string => {
  if (code >= 200 && code < 300) return "2xx";
  if (code >= 300 && code < 400) return "3xx";
  if (code >= 400 && code < 500) return "4xx";
  if (code >= 500 && code < 600) return "5xx";
  if (code >= 100 && code < 200) return "1xx";
  return "other";
};

/**
 * Hono's `:param` template → OpenAPI-style `{param}`, so dashboards built
 * off endpoint paths share labels with the metrics. Wildcards collapse to a
 * single bucket to keep cardinality bounded.
 */
const normalizeRoute = (raw: string | undefined): string => {
  if (!raw) return "unmatched";
  if (raw === "/*" || raw === "*") return "unmatched";
  return raw.replace(/:([A-Za-z_][\w]*)/g, "{$1}");
};

/**
 * Get the bundle filename (for byte-counting) from the URL. Returns "" for
 * non-bundle routes so the bytes-served counter doesn't get polluted.
 */
const extractFilename = (path: string): string => {
  const m = path.match(/\/([a-z0-9_-]+\.csv\.zst)$/i);
  return m?.[1] ?? "";
};

export const metricsMiddleware = (m: DataMetricsRegistry): MiddlewareHandler => {
  return async (c, next) => {
    const start = performance.now();
    m.http.inFlight.inc();
    try {
      await next();
    } finally {
      m.http.inFlight.dec();

      const route = normalizeRoute(c.req.routePath);
      const dur = (performance.now() - start) / 1000;
      const status = c.res?.status ?? 500;
      const cls = statusClass(status);

      m.http.requests.labels({ route, status_class: cls }).inc();
      m.http.duration.labels({ route }).observe(dur);

      // Count bytes only for successful bundle downloads — manifests are
      // small and not worth bucketing per name.
      if (status >= 200 && status < 300) {
        const filename = extractFilename(c.req.path);
        if (filename) {
          const len = Number(c.res?.headers.get("Content-Length") ?? 0);
          if (len > 0) m.http.bytesServed.labels({ filename }).inc(len);
        }
      }
    }
  };
};
