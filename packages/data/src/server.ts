import { Hono } from "hono";
import { join } from "node:path";
import type { DataMetricsRegistry } from "./metrics/registry";
import { metricsMiddleware } from "./metrics/middleware";
import { metricsAuth } from "./metrics/auth";

// Strict allowlist for served artifacts. The pattern also rejects path
// traversal (`/`, `..`) by virtue of only allowing word chars + `-`.
const ARTIFACT_NAME = /^[a-z0-9_-]+\.csv\.zst$/i;

export type ServerOptions = {
  /** Where the bundle files live on disk. */
  outputDir: string;
  /** Prom-client registry — required so /metrics has something to expose. */
  metrics: DataMetricsRegistry;
  /** When false, the /metrics route and the HTTP RED middleware are no-ops. */
  metricsEnabled: boolean;
  /** Bearer token gating /metrics. Empty/undefined → open mode. */
  metricsToken: string | undefined;
  /** Override the scrape path. Default "/metrics". */
  metricsPath?: string;
};

/**
 * Build a Hono app that serves the bundles.
 *
 *   GET /health                 liveness (root, unversioned)
 *   GET /metrics                Prometheus scrape (root, gated by token)
 *   GET /v1/latest.json         manifest (no-cache; 404 before first build)
 *   GET /v1/:filename           static *.csv.zst stream (immutable cache)
 *
 * The /v1 prefix is manifest-schema versioning (not the dataset version,
 * which lives inside `manifest.json` as `version`). A breaking change to
 * the manifest format would coexist as /v2/latest.json without disturbing
 * /v1 consumers.
 */
export const createServer = (opts: ServerOptions): Hono => {
  const app = new Hono();
  const metricsPath = opts.metricsPath ?? "/metrics";

  // Ops endpoints stay at root, unversioned and uninstrumented (the file
  // server metrics are about bundle traffic, not probe traffic).
  app.get("/health", (c) => c.json({ status: "ok" }));

  if (opts.metricsEnabled) {
    app.get(
      metricsPath,
      metricsAuth(opts.metricsToken),
      async (c) => {
        const body = await opts.metrics.registry.metrics();
        return new Response(body, {
          status: 200,
          headers: { "Content-Type": opts.metrics.registry.contentType },
        });
      },
    );
    app.use("/v1/*", metricsMiddleware(opts.metrics));
  }

  app.get("/v1/latest.json", async (c) => {
    const file = Bun.file(join(opts.outputDir, "latest.json"));
    if (!(await file.exists())) {
      return c.json({ error: "dataset not yet built" }, 404);
    }
    return new Response(file.stream(), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
      },
    });
  });

  app.get("/v1/:filename", async (c) => {
    const filename = c.req.param("filename");
    if (!ARTIFACT_NAME.test(filename)) {
      return c.json({ error: "invalid filename" }, 400);
    }
    const file = Bun.file(join(opts.outputDir, filename));
    if (!(await file.exists())) {
      return c.json({ error: "not found" }, 404);
    }
    // Set Content-Length so the metrics middleware can credit bytes-served.
    const size = file.size;
    return new Response(file.stream(), {
      headers: {
        "Content-Type": "application/zstd",
        "Cache-Control": "public, max-age=86400, immutable",
        "Content-Length": String(size),
      },
    });
  });

  return app;
};
