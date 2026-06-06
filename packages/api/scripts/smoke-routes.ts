#!/usr/bin/env bun
/**
 * Smoke test for the HTTP layer: routes + auth + rate-limit + OpenAPI.
 * Boots the full app, runs requests against `app.fetch` directly (no
 * network), and asserts.
 *
 *   docker run -d --rm --name pg ... timescale/timescaledb-ha:pg17-all
 *   DATABASE_URL=... DATA_URL=http://localhost:19996 [API_KEY=secret] \
 *     bun packages/api/scripts/smoke-routes.ts
 */
import { sql } from "bun";
import { Hono } from "hono";
import { migrate } from "../src/migrate";
import { ingestAll } from "../src/loader/ingest";
import { fetchManifest } from "../src/loader/manifest";
import { _resetRateLimitForTests } from "../src/lib/ratelimit";

const PORT = 19996;

// ─── tiny synthetic dataset (same shape as smoke-service) ─────────────────────

const PLACES =
  "geonameid,name,asciiname,latitude,longitude,feature_class,feature_code,country_code,admin1_code,admin2_code,population,elevation,timezone\n" +
  "2950159,Berlin,Berlin,52.52437,13.41053,P,PPLC,DE,16,00,3645000,34,Europe/Berlin\n" +
  "5128581,New York City,New York City,40.71427,-74.00597,P,PPL,US,NY,061,8175133,10,America/New_York\n";
const POSTAL =
  "country_code,postal_code,place_name,admin_name1,admin_code1,latitude,longitude\n" +
  "DE,10115,Berlin Mitte,Berlin,16,52.5326,13.3850\n";
const COUNTRIES =
  "code,code3,name,capital,continent,currency_code,languages,calling_code,flag_emoji\n" +
  "DE,DEU,Germany,Berlin,EU,EUR,de,49,🇩🇪\n" +
  "US,USA,United States,Washington,NA,USD,en-US,1,🇺🇸\n";
const ADDR_DE =
  "gid,latitude,longitude,house_number,street,unit,city,postcode,region,country_code\n" +
  "oa:de:1,52.52437,13.41053,12,Müllerstraße,,Berlin,10115,Berlin,DE\n";

const compress = async (data: string): Promise<Uint8Array> => {
  const p = Bun.spawn(["zstd", "-q"], { stdin: "pipe", stdout: "pipe" });
  p.stdin.write(new TextEncoder().encode(data));
  await p.stdin.end();
  const b = new Uint8Array(await new Response(p.stdout).arrayBuffer());
  if ((await p.exited) !== 0) throw new Error("zstd failed");
  return b;
};
const sha256 = async (b: Uint8Array): Promise<string> => {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", b as BufferSource));
  let hex = "";
  for (const x of d) hex += x.toString(16).padStart(2, "0");
  return hex;
};
const linecount = (s: string) => (s.match(/\n/g) ?? []).length;

const seed = async (): Promise<{ stop: () => void }> => {
  const places = await compress(PLACES);
  const postal = await compress(POSTAL);
  const countries = await compress(COUNTRIES);
  const addrDe = await compress(ADDR_DE);

  const manifest = {
    built_at: new Date().toISOString(),
    version: "smoke-v1",
    license: { geonames: "CC-BY-4.0" },
    files: {
      places: { filename: "places.csv.zst", sha256: await sha256(places), size_bytes: places.byteLength, line_count: linecount(PLACES) },
      postal_codes: { filename: "postal_codes.csv.zst", sha256: await sha256(postal), size_bytes: postal.byteLength, line_count: linecount(POSTAL) },
      countries: { filename: "countries.csv.zst", sha256: await sha256(countries), size_bytes: countries.byteLength, line_count: linecount(COUNTRIES) },
      addresses: [
        { filename: "addresses-de.csv.zst", sha256: await sha256(addrDe), size_bytes: addrDe.byteLength, line_count: linecount(ADDR_DE), country_code: "DE" },
      ],
    },
    coverage: { DE: "address" },
    sources: {
      geonames_cities_url: "https://example.com/cities.zip",
      geonames_postal_url: "https://example.com/postal.zip",
      geonames_country_info_url: "https://example.com/countryInfo.txt",
      openaddresses_url: "https://example.com/oa.zip",
    },
  };

  const files: Record<string, Uint8Array> = {
    "places.csv.zst": places, "postal_codes.csv.zst": postal,
    "countries.csv.zst": countries, "addresses-de.csv.zst": addrDe,
  };
  const app = new Hono();
  app.get("/latest.json", (c) => c.json(manifest));
  app.get("/:filename", (c) => {
    const b = files[c.req.param("filename")];
    if (!b) return c.json({ error: "nf" }, 404);
    return new Response(b as BodyInit, { headers: { "Content-Type": "application/zstd" } });
  });
  const server = Bun.serve({ port: PORT, fetch: app.fetch });

  const m = await fetchManifest(`http://localhost:${PORT}`);
  await ingestAll(`http://localhost:${PORT}`, m, "fp-smoke");

  return { stop: () => server.stop(true) };
};

// ─── assertions ──────────────────────────────────────────────────────────────

const assert = (cond: boolean, what: string): void => {
  if (!cond) throw new Error(`assert: ${what}`);
};
const assertJson = async <T = unknown>(
  resp: Response,
  status: number,
  what: string,
): Promise<T> => {
  if (resp.status !== status) {
    const body = await resp.text();
    throw new Error(`${what}: expected ${status}, got ${resp.status}: ${body}`);
  }
  return (await resp.json()) as T;
};

// ─── main ────────────────────────────────────────────────────────────────────

const main = async (): Promise<void> => {
  console.log("==> migrate");
  await migrate();
  console.log("==> seed dataset");
  const seeded = await seed();

  // Build the app via the factory — no side effects, no loader, no signal handlers.
  console.log("==> createApp");
  const { createApp } = await import("../src/app");
  const { app } = await createApp();
  const req = (path: string, init?: RequestInit) =>
    app.fetch(new Request(`http://localhost${path}`, init));

  try {
    // ─── /health and /ready ──────────────────────────────────────────────────
    console.log("==> /health");
    {
      const r = await req("/health");
      const j = await assertJson<{ status: string }>(r, 200, "/health");
      assert(j.status === "ok", "/health status");
    }
    console.log("==> /ready (loaded)");
    {
      const r = await req("/ready");
      const j = await assertJson<{ status: string; places_count: number }>(r, 200, "/ready");
      assert(j.status === "ready", "/ready status");
      assert(j.places_count === 2, `places_count=${j.places_count}`);
    }

    // ─── /v1/search ─────────────────────────────────────────────────────────
    _resetRateLimitForTests();
    console.log("==> GET /v1/search?q=berlin");
    {
      const r = await req("/v1/search?q=berlin&limit=3");
      const j = await assertJson<{ features: { name: string }[] }>(r, 200, "/v1/search");
      assert(j.features[0]?.name === "Berlin", `top=${j.features[0]?.name}`);
      assert(
        r.headers.get("X-RateLimit-Remaining") !== null,
        "rate-limit headers present",
      );
    }

    console.log("==> GET /v1/search invalid layer → 400 with ErrorSchema body");
    {
      const r = await req("/v1/search?q=x&layers=garbage");
      const j = await assertJson<{ error: string; code: string }>(
        r, 400, "/v1/search bad layer",
      );
      assert(j.code === "BAD_INPUT", `expected code=BAD_INPUT, got ${j.code}`);
      assert(typeof j.error === "string" && j.error.includes("validation failed"), `error="${j.error}"`);
    }

    console.log("==> GET /v1/search empty proximity_lat → 400");
    {
      const r = await req("/v1/search?q=x&proximity_lat=");
      const j = await assertJson<{ code: string }>(r, 400, "/v1/search empty proximity");
      assert(j.code === "BAD_INPUT", `code=${j.code}`);
    }

    console.log("==> POST /v1/batch without Content-Type → 400");
    {
      const r = await req("/v1/batch", {
        method: "POST",
        body: JSON.stringify({ entries: [{ type: "search", q: "x" }] }),
      });
      assert(r.status === 400, `expected 400, got ${r.status}`);
    }

    // ─── /v1/reverse ────────────────────────────────────────────────────────
    console.log("==> GET /v1/reverse");
    {
      const r = await req("/v1/reverse?lat=52.52&lng=13.41&limit=3");
      const j = await assertJson<{ features: { distance_km: number }[] }>(r, 200, "/v1/reverse");
      assert(j.features.length > 0, "expected >=1 feature");
      assert((j.features[0]?.distance_km ?? 999) < 1, "expected <1km");
    }

    // ─── /v1/place/:gid ─────────────────────────────────────────────────────
    console.log("==> GET /v1/place/:gid");
    {
      const r = await req("/v1/place/geonames:2950159");
      const j = await assertJson<{ name: string }>(r, 200, "/v1/place hit");
      assert(j.name === "Berlin", `got ${j.name}`);
    }
    console.log("==> GET /v1/place/missing → 404");
    {
      const r = await req("/v1/place/geonames:does-not-exist");
      assert(r.status === 404, `expected 404, got ${r.status}`);
    }

    // ─── /v1/countries ──────────────────────────────────────────────────────
    console.log("==> GET /v1/countries");
    {
      const r = await req("/v1/countries");
      const j = await assertJson<{ countries: { code: string }[]; total: number }>(r, 200, "/v1/countries");
      assert(j.total === 2, `total=${j.total}`);
    }
    console.log("==> GET /v1/countries/de");
    {
      const r = await req("/v1/countries/de");
      const j = await assertJson<{ name: string }>(r, 200, "/v1/countries/de");
      assert(j.name === "Germany", `got ${j.name}`);
    }
    console.log("==> GET /v1/countries/xy → 404");
    {
      const r = await req("/v1/countries/xy");
      assert(r.status === 404, `expected 404, got ${r.status}`);
    }
    console.log("==> GET /v1/countries/abc → 400 (regex)");
    {
      const r = await req("/v1/countries/abc");
      assert(r.status === 400, `expected 400, got ${r.status}`);
    }

    // ─── /v1/postal ─────────────────────────────────────────────────────────
    console.log("==> GET /v1/postal?code=10115");
    {
      const r = await req("/v1/postal?code=10115");
      const j = await assertJson<{ postal_codes: { place_name: string }[] }>(r, 200, "/v1/postal");
      assert(
        j.postal_codes[0]?.place_name === "Berlin Mitte",
        `got ${j.postal_codes[0]?.place_name}`,
      );
    }
    console.log("==> GET /v1/postal (no params) → 400");
    {
      const r = await req("/v1/postal");
      assert(r.status === 400, `expected 400, got ${r.status}`);
    }

    // ─── /v1/coverage ───────────────────────────────────────────────────────
    console.log("==> GET /v1/coverage");
    {
      const r = await req("/v1/coverage");
      const j = await assertJson<{ countries: Record<string, string> }>(r, 200, "/v1/coverage");
      assert(j.countries["DE"] === "address", `DE=${j.countries["DE"]}`);
      assert(j.countries["US"] === "place_only", `US=${j.countries["US"]}`);
    }

    // ─── /v1/batch ──────────────────────────────────────────────────────────
    console.log("==> POST /v1/batch");
    {
      const r = await req("/v1/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entries: [
            { type: "search", q: "berlin", limit: 1 },
            { type: "reverse", lat: 52.52, lng: 13.41, limit: 1 },
          ],
        }),
      });
      const j = await assertJson<{ results: { features: { name: string }[] }[] }>(r, 200, "/v1/batch");
      assert(j.results.length === 2, "results length");
      assert(j.results[0]!.features[0]?.name === "Berlin", "batch[0]");
    }

    // ─── rate limit ──────────────────────────────────────────────────────────
    console.log("==> rate limit (1/min via direct env override)");
    {
      // We can't change config.ratelimitPerMinute live, but we know default
      // is 60 — fire 65 from same X-Forwarded-For and expect 429s near the end.
      _resetRateLimitForTests();
      let okCount = 0, throttled = 0;
      for (let i = 0; i < 65; i++) {
        const r = await req("/v1/coverage", {
          headers: { "X-Forwarded-For": "203.0.113.42" },
        });
        if (r.status === 200) okCount++;
        else if (r.status === 429) throttled++;
      }
      assert(okCount === 60, `expected 60 ok, got ${okCount}`);
      assert(throttled === 5, `expected 5 throttled, got ${throttled}`);

      // A different IP should not be throttled.
      const r = await req("/v1/coverage", {
        headers: { "X-Forwarded-For": "203.0.113.99" },
      });
      assert(r.status === 200, `different IP should pass: ${r.status}`);
    }

    // ─── OpenAPI + docs ──────────────────────────────────────────────────────
    console.log("==> GET /openapi.json");
    {
      const r = await req("/openapi.json");
      const j = await assertJson<{
        openapi: string;
        paths: Record<string, unknown>;
      }>(r, 200, "/openapi.json");
      assert(typeof j.openapi === "string", "openapi field");
      const expected = [
        "/v1/search",
        "/v1/reverse",
        "/v1/place/{gid}",
        "/v1/countries",
        "/v1/countries/{code}",
        "/v1/postal",
        "/v1/coverage",
        "/v1/batch",
      ];
      for (const p of expected) {
        assert(p in j.paths, `path missing in spec: ${p}`);
      }
      console.log(`   ${expected.length}/${expected.length} paths present ✓`);
    }
    console.log("==> GET /docs");
    {
      const r = await req("/docs");
      assert(r.status === 200, `/docs status=${r.status}`);
      const html = await r.text();
      assert(html.includes("Scalar") || html.includes("scalar"), "Scalar HTML");
    }

    console.log("\n✓ Routes smoke succeeded");
  } finally {
    seeded.stop();
    await sql.end();
  }
};

await main();
process.exit(0);
