import { sql } from "bun";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { bearerAuth } from "hono/bearer-auth";
import { cors } from "hono/cors";
import { Scalar } from "@scalar/hono-api-reference";
import { generateSpecs } from "hono-openapi";
import { createMarkdownFromOpenApi } from "@scalar/openapi-to-markdown";
import { config } from "./config";
import { rateLimit } from "./lib/ratelimit";
import { geoRoutes } from "./routes";
import { createRegistry, type MetricsRegistry } from "./metrics/registry";
import { metricsMiddleware } from "./metrics/middleware";
import { metricsAuth } from "./metrics/auth";

/**
 * Build the Hono app: routes, middleware, OpenAPI spec, error handlers.
 *
 * Pure factory — does NOT run migrations, doesn't start the loader, and
 * doesn't register signal handlers. The executable entrypoint
 * (`src/index.ts`) is responsible for those side-effects. Tests can call
 * this directly after seeding the DB.
 */
export const createApp = async (): Promise<{
  app: Hono;
  spec: object;
  llmsTxt: string;
  metrics: MetricsRegistry;
}> => {
  const app = new Hono();

  // Registry is always built — the loader feeds dataset gauges from boot
  // and tests want stable handles. Only the /metrics route and the RED
  // middleware are gated on METRICS_ENABLED, so an unscraped registry
  // costs a few KB and nothing else.
  const metrics = createRegistry();

  // Logger — skip /health and /ready so probe traffic doesn't drown real
  // requests in the log. Everything else is logged.
  app.use("*", async (c, next) => {
    const path = c.req.path;
    if (path === "/health" || path === "/ready") return next();
    return logger()(c, next);
  });

  // CORS: open API → allow any origin. Authorization header is permitted
  // (the Bearer auth path), but credentials:include is NOT — `origin: "*"`
  // is incompatible with credentialed requests anyway, and we don't use
  // cookies. Browsers cache the preflight for a day.
  app.use(
    "*",
    cors({
      origin: "*",
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["Authorization", "Content-Type"],
      maxAge: 86400,
    }),
  );

  app.use(
    "*",
    secureHeaders({
      xFrameOptions: "DENY",
      xContentTypeOptions: "nosniff",
      referrerPolicy: "strict-origin-when-cross-origin",
    }),
  );

  // ─── /health (liveness) ─────────────────────────────────────────────────────
  // Always 200 once the process can serve. Doesn't check DB — for k8s
  // liveness, restarting on DB-down doesn't help anyway.
  app.get("/health", (c) => c.json({ status: "ok" as const }));

  // ─── /ready (readiness) ─────────────────────────────────────────────────────
  // 503 until the loader has committed a dataset. Wraps DB calls in
  // try/catch so a DB outage surfaces as a deliberate readiness failure
  // (not a generic 500).
  app.get("/ready", async (c) => {
    try {
      const [row] = await sql<
        {
          places: number;
          addresses: number;
          postal: number;
          loaded_at: Date | null;
          dataset_version: string | null;
        }[]
      >`
        SELECT
          (SELECT COUNT(*)::int FROM geomark.places)        AS places,
          (SELECT COUNT(*)::int FROM geomark.addresses)     AS addresses,
          (SELECT COUNT(*)::int FROM geomark.postal_codes)  AS postal,
          m.loaded_at, m.dataset_version
        FROM geomark.meta m
        WHERE m.id = TRUE
      `;
      const ready = row?.loaded_at != null;
      return c.json(
        {
          status: ready ? ("ready" as const) : ("loading" as const),
          dataset_version: row?.dataset_version ?? null,
          data_loaded_at: row?.loaded_at ? row.loaded_at.toISOString() : null,
          places_count: row?.places ?? 0,
          addresses_count: row?.addresses ?? 0,
          postal_codes_count: row?.postal ?? 0,
        },
        ready ? 200 : 503,
      );
    } catch (err) {
      console.error("[/ready] db error:", err);
      return c.json(
        { status: "error" as const, error: "database unavailable" },
        503,
      );
    }
  });

  // ─── /metrics (Prometheus) ─────────────────────────────────────────────────
  // Mounted at the root, NOT under /v1 — Prometheus convention,
  // not part of the public API contract. Bearer-auth gated via layered
  // METRICS_TOKEN → API_KEY → open mode (see ./metrics/auth.ts).
  //
  // The route is registered BEFORE the RED middleware below intentionally:
  // a self-instrumented scrape endpoint would tick its own counter on
  // every Prometheus poll, skewing the request-rate series.
  if (config.metricsEnabled) {
    app.get(
      config.metricsPath,
      metricsAuth(config.metricsToken, config.apiKey),
      async (c) => {
        const body = await metrics.registry.metrics();
        return c.body(body, 200, {
          "Content-Type": metrics.registry.contentType,
        });
      },
    );
  }

  // ─── OpenAPI + Scalar UI + llms.txt (registered first, public) ─────────────
  // These routes are registered BEFORE the v1 sub-app mount on purpose:
  // Hono dispatches in registration order, so docs win the route trie and
  // skip the v1 sub-app's rate-limit + bearer-auth middleware entirely.
  //
  // Spec and llmsTxt are populated AFTER the v1 routes are mounted (the
  // generateSpecs call below); the handlers close over the binding, so
  // requests that arrive after createApp() resolves see the final values.
  let spec: object = {};
  let llmsTxt = "";
  app.get("/v1/openapi.json", (c) => c.json(spec));
  app.get(
    "/v1/docs",
    Scalar({ theme: "saturn", url: "/v1/openapi.json" }),
  );
  app.get("/v1/llms.txt", (c) => c.text(llmsTxt));

  // ─── /v1/* (rate-limited + optionally auth-gated) ──────────────────────
  // The container serves under /v1 directly. Operators who don't want
  // the prefix can strip it at the gateway (e.g. Traefik StripPrefix).
  //
  // RED middleware wraps the v1 sub-app so 429s from rate-limit and 401s
  // from bearer-auth are visible in the same series as application errors.
  if (config.metricsEnabled) {
    app.use("/v1/*", metricsMiddleware(metrics));
  }
  const v1 = new Hono();
  v1.use(
    "/*",
    rateLimit({
      limit: config.ratelimitPerMinute,
      trustedProxyHops: config.trustedProxyHops,
    }),
  );
  if (config.requiresAuth) {
    v1.use(
      "/*",
      bearerAuth({
        token: config.apiKey!,
        // Default bearerAuth returns plain-text bodies. We coerce to JSON
        // matching ErrorSchema so the API contract stays consistent.
        noAuthenticationHeaderMessage: {
          error: "missing Bearer token",
          code: "UNAUTHORIZED",
        },
        invalidAuthenticationHeaderMessage: {
          error: "malformed Authorization header",
          code: "UNAUTHORIZED",
        },
        invalidTokenMessage: {
          error: "invalid token",
          code: "UNAUTHORIZED",
        },
      }),
    );
  }
  v1.route("/", geoRoutes);
  app.route("/v1", v1);

  // ─── OpenAPI spec generation ───────────────────────────────────────────────
  // Routes are now mounted; assemble the spec and llms.txt and write them
  // back into the closures the public handlers already use.
  spec = await generateSpecs(app, {
    documentation: {
      info: {
        title: "Geomark",
        version: "0.1.0",
        description:
          "Geocoding API for places, addresses, and postal codes — forward " +
          "search, reverse lookup, multilingual aliases, fuzzy matching.\n\n" +
          "Run it on your own infrastructure (open source, MIT — " +
          "https://github.com/valentinkolb/geomark) or use the free hosted " +
          "version at https://geomark.dev.\n\n" +
          "Raw compressed CSV bundles are also served at https://geomark.dev/data " +
          "if you'd rather pull the data and query it locally.\n\n" +
          "Data comes from GeoNames (CC BY 4.0) and OpenAddresses contributors " +
          "(mixed per-source licenses). When redistributing, keep the credit " +
          "lines from `GET /v1/attribution` intact — the `info.license` " +
          "below applies to the dataset; the API code itself is MIT.",
        license: {
          name: "CC BY 4.0 (data)",
          url: "https://creativecommons.org/licenses/by/4.0/",
        },
        contact: {
          name: "Geomark",
          url: "https://geomark.dev",
        },
      },
      servers: [{ url: "/", description: "current host" }],
      tags: [
        {
          name: "Search",
          description: "Find features by free text or coordinates.",
        },
        {
          name: "Lookup",
          description: "Resolve a known identifier or alternate code.",
        },
        {
          name: "Reference",
          description: "Static reference data: postal codes, countries, coverage.",
        },
      ],
    },
  });
  llmsTxt = await createMarkdownFromOpenApi(JSON.stringify(spec));

  // ─── error handling ─────────────────────────────────────────────────────────
  app.notFound((c) => c.json({ error: "not found", code: "NOT_FOUND" }, 404));
  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    console.error("[Geomark] Error:", err);
    return c.json({ error: "internal error", code: "INTERNAL" }, 500);
  });

  return { app, spec, llmsTxt, metrics };
};
