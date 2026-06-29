import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createRegistry } from "../src/metrics/registry";
import { metricsMiddleware } from "../src/metrics/middleware";
import { metricsAuth } from "../src/metrics/auth";
import {
  installRuntimeMetrics,
  recordCacheEvent,
  recordRateLimitCheck,
  recordRedisError,
} from "../src/metrics/runtime";

// ─── registry ────────────────────────────────────────────────────────────────

describe("metrics registry", () => {
  test("scrape output contains the expected named series + HELP lines", async () => {
    const m = createRegistry({ version: "1.2.3", commit: "abcdef" });
    // touch a counter so it appears in the scrape (prom-client only emits
    // counters with at least one observation when they're labelled).
    m.http.requests.labels({ route: "/v1/search", status_class: "2xx" }).inc();
    m.http.duration.labels({ route: "/v1/search" }).observe(0.012);
    m.dataset.places.set(33676);
    m.dataset.versionInfo.labels({ version: "2026-05-13" }).set(1);
    m.cache.events.labels({ scope: "random", result: "hit" }).inc();
    m.redisErrors.labels({ operation: "read" }).inc();
    m.ratelimitChecks
      .labels({ backend: "redis", outcome: "allowed" })
      .inc();

    const body = await m.registry.metrics();

    // HELP + TYPE lines + an actual sample for each metric we care about.
    for (const series of [
      "geomark_http_requests_total",
      "geomark_http_request_duration_seconds",
      "geomark_http_in_flight",
      "geomark_places_total",
      "geomark_dataset_version_info",
      "geomark_cache_events_total",
      "geomark_redis_errors_total",
      "geomark_ratelimit_checks_total",
      "geomark_build_info",
      // default-collector spot check (node_process metrics live)
      "process_resident_memory_bytes",
    ]) {
      expect(body).toContain(`# HELP ${series}`);
    }
    expect(body).toContain('geomark_build_info{version="1.2.3",commit="abcdef"} 1');
    expect(body).toContain('geomark_places_total 33676');
    expect(body).toContain(
      'geomark_http_requests_total{route="/v1/search",status_class="2xx"} 1',
    );
    expect(body).toContain(
      'geomark_cache_events_total{scope="random",result="hit"} 1',
    );
    expect(body).toContain('geomark_redis_errors_total{operation="read"} 1');
    expect(body).toContain(
      'geomark_ratelimit_checks_total{backend="redis",outcome="allowed"} 1',
    );
  });

  test("dataset version label rotates cleanly", async () => {
    const m = createRegistry();
    m.dataset.versionInfo.labels({ version: "v1" }).set(1);
    // mimic recordDatasetLoaded()'s reset-then-set so a rotation leaves
    // exactly one version series, not two.
    m.dataset.versionInfo.reset();
    m.dataset.versionInfo.labels({ version: "v2" }).set(1);

    const body = await m.registry.metrics();
    expect(body).toContain('geomark_dataset_version_info{version="v2"} 1');
    expect(body).not.toContain('version="v1"');
  });

  test("two registries are isolated", async () => {
    const a = createRegistry();
    const b = createRegistry();
    a.http.inFlight.inc();
    a.http.inFlight.inc();
    // b untouched
    const aBody = await a.registry.metrics();
    const bBody = await b.registry.metrics();
    expect(aBody).toContain("geomark_http_in_flight 2");
    expect(bBody).toContain("geomark_http_in_flight 0");
  });

  test("runtime metrics helpers write to the installed registry", async () => {
    const m = createRegistry();
    installRuntimeMetrics(m);

    recordCacheEvent("coverage", "miss");
    recordRedisError("write");
    recordRateLimitCheck("memory", "fallback_rejected");

    const body = await m.registry.metrics();
    expect(body).toContain(
      'geomark_cache_events_total{scope="coverage",result="miss"} 1',
    );
    expect(body).toContain('geomark_redis_errors_total{operation="write"} 1');
    expect(body).toContain(
      'geomark_ratelimit_checks_total{backend="memory",outcome="fallback_rejected"} 1',
    );
  });
});

// ─── middleware ──────────────────────────────────────────────────────────────

describe("metrics middleware", () => {
  const buildApp = () => {
    const m = createRegistry();
    const app = new Hono();
    app.use("/v1/*", metricsMiddleware(m));
    const v1 = new Hono()
      .get("/search", (c) => c.json({ ok: true }))
      .get("/place/:gid", (c) => c.json({ gid: c.req.param("gid") }))
      .get("/boom", () => {
        throw new Error("kaboom");
      });
    app.route("/v1", v1);
    app.onError((_err, c) => c.json({ error: "internal" }, 500));
    return { app, m };
  };

  test("records request_total + duration with route template label", async () => {
    const { app, m } = buildApp();
    await app.request("/v1/search?q=berlin");
    await app.request("/v1/search?q=munich");
    await app.request("/v1/place/G123");

    const body = await m.registry.metrics();
    expect(body).toContain(
      'geomark_http_requests_total{route="/v1/search",status_class="2xx"} 2',
    );
    // Hono's :gid → OpenAPI-style {gid} normalization
    expect(body).toContain(
      'geomark_http_requests_total{route="/v1/place/{gid}",status_class="2xx"} 1',
    );
    expect(body).toMatch(
      /geomark_http_request_duration_seconds_count\{route="\/v1\/search"\} 2/,
    );
  });

  test("5xx counts as status_class=5xx and in_flight returns to zero", async () => {
    const { app, m } = buildApp();
    const before = await m.http.inFlight.get();
    expect(before.values[0]?.value).toBe(0);
    const res = await app.request("/v1/boom");
    expect(res.status).toBe(500);
    const body = await m.registry.metrics();
    expect(body).toContain(
      'geomark_http_requests_total{route="/v1/boom",status_class="5xx"} 1',
    );
    expect(body).toContain("geomark_http_in_flight 0");
  });

  test("infers rate-limit + auth rejection reasons from status + headers", async () => {
    const m = createRegistry();
    const app = new Hono();
    app.use("/v1/*", metricsMiddleware(m));
    app.get("/v1/throttled", (c) => c.json({ error: "limit" }, 429));
    app.get("/v1/protected", (c) => c.json({ error: "unauth" }, 401));

    await app.request("/v1/throttled");
    await app.request("/v1/protected"); // no Authorization → reason=missing
    await app.request("/v1/protected", {
      headers: { Authorization: "Basic deadbeef" },
    }); // malformed (not Bearer)
    await app.request("/v1/protected", {
      headers: { Authorization: "Bearer wrong" },
    }); // invalid

    const body = await m.registry.metrics();
    expect(body).toContain("geomark_ratelimit_rejected_total 1");
    expect(body).toContain(
      'geomark_auth_rejected_total{reason="missing"} 1',
    );
    expect(body).toContain(
      'geomark_auth_rejected_total{reason="malformed"} 1',
    );
    expect(body).toContain(
      'geomark_auth_rejected_total{reason="invalid"} 1',
    );
  });
});

// ─── auth gate ───────────────────────────────────────────────────────────────

describe("metrics auth gate", () => {
  const protectedApp = (token?: string, apiKey?: string) => {
    const app = new Hono();
    app.get("/metrics", metricsAuth(token, apiKey), (c) => c.text("# scrape", 200));
    return app;
  };

  test("open mode passes through when neither token nor api key set", async () => {
    const res = await protectedApp(undefined, undefined).request("/metrics");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("# scrape");
  });

  test("METRICS_TOKEN required when set", async () => {
    const app = protectedApp("scrape-secret");
    expect((await app.request("/metrics")).status).toBe(401);
    expect(
      (
        await app.request("/metrics", {
          headers: { Authorization: "Bearer scrape-secret" },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request("/metrics", {
          headers: { Authorization: "Bearer wrong" },
        })
      ).status,
    ).toBe(401);
  });

  test("falls back to API_KEY when METRICS_TOKEN unset", async () => {
    const app = protectedApp(undefined, "api-key-xyz");
    expect((await app.request("/metrics")).status).toBe(401);
    expect(
      (
        await app.request("/metrics", {
          headers: { Authorization: "Bearer api-key-xyz" },
        })
      ).status,
    ).toBe(200);
  });

  test("METRICS_TOKEN wins over API_KEY when both set", async () => {
    const app = protectedApp("scrape-only", "general-key");
    expect(
      (
        await app.request("/metrics", {
          headers: { Authorization: "Bearer general-key" },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await app.request("/metrics", {
          headers: { Authorization: "Bearer scrape-only" },
        })
      ).status,
    ).toBe(200);
  });

  test("rejects malformed Authorization header (not Bearer)", async () => {
    const res = await protectedApp("t").request("/metrics", {
      headers: { Authorization: "Basic dXNlcjpwdw==" },
    });
    expect(res.status).toBe(401);
  });

  test("rejects empty Bearer (just whitespace)", async () => {
    const res = await protectedApp("t").request("/metrics", {
      headers: { Authorization: "Bearer   " },
    });
    expect(res.status).toBe(401);
  });
});
