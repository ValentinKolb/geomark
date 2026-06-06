import { afterAll, describe, expect, test } from "bun:test";
import { spawnTestDb, setDatabaseUrl } from "./lib/testdb";
import { seedDataset } from "./lib/seed";

const db = await spawnTestDb();
setDatabaseUrl(db.url);
const { sql } = await import("bun");
const { migrate } = await import("../src/migrate");
await migrate();
const seed = await seedDataset();
const { _resetRateLimitForTests: resetRateLimit } = await import(
  "../src/lib/ratelimit"
);
const { createApp } = await import("../src/app");
const { app } = await createApp();

const req = (path: string, init?: RequestInit) =>
  app.fetch(new Request(`http://localhost${path}`, init));

afterAll(async () => {
  seed.stop();
  await sql.end().catch(() => {});
  await db.stop();
});

describe("/health and /ready", () => {
  test("/health is 200 ok", async () => {
    const r = await req("/health");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: "ok" });
  });

  test("/ready is 200 with counts when data is loaded", async () => {
    const r = await req("/ready");
    expect(r.status).toBe(200);
    const j = (await r.json()) as {
      status: string;
      places_count: number;
      addresses_count: number;
      data_loaded_at: string;
    };
    expect(j.status).toBe("ready");
    expect(j.places_count).toBe(6);
    expect(j.addresses_count).toBe(5);
    expect(typeof j.data_loaded_at).toBe("string");
  });

  test("/ready is 503 status='loading' when meta has no loaded_at", async () => {
    // Simulate the pre-load state by clearing meta. Restore right after so
    // subsequent tests still see a ready dataset.
    await sql`UPDATE geomark.meta SET loaded_at = NULL, dataset_version = NULL`;
    try {
      const r = await req("/ready");
      expect(r.status).toBe(503);
      const j = (await r.json()) as {
        status: string;
        data_loaded_at: string | null;
      };
      expect(j.status).toBe("loading");
      expect(j.data_loaded_at).toBeNull();
    } finally {
      // Restore meta so other tests are unaffected.
      await sql`
        UPDATE geomark.meta SET
          dataset_version = ${seed.fingerprint},
          loaded_at = NOW()
      `;
    }
  });
});

describe("/geo routes — happy paths", () => {
  test("GET /api/v1/search?q=berlin", async () => {
    resetRateLimit();
    const r = await req("/api/v1/search?q=berlin&limit=3");
    expect(r.status).toBe(200);
    const j = (await r.json()) as { features: { name: string }[] };
    expect(j.features[0]?.name).toBe("Berlin");
  });

  test("GET /api/v1/reverse", async () => {
    resetRateLimit();
    const r = await req("/api/v1/reverse?lat=52.52&lng=13.41&limit=3");
    expect(r.status).toBe(200);
    const j = (await r.json()) as { features: { distance_km: number }[] };
    expect(j.features[0]?.distance_km ?? 999).toBeLessThan(0.5);
  });

  test("GET /api/v1/place/:gid (hit) returns {place, aliases}", async () => {
    resetRateLimit();
    const r = await req("/api/v1/place/geonames:2950159");
    expect(r.status).toBe(200);
    const j = (await r.json()) as {
      place: { name: string };
      aliases: unknown[];
    };
    expect(j.place.name).toBe("Berlin");
    expect(Array.isArray(j.aliases)).toBe(true);
  });

  test("GET /api/v1/code/:kind/:value (404 when no aliases dataset loaded)", async () => {
    resetRateLimit();
    const r = await req("/api/v1/code/iata/MUC");
    expect(r.status).toBe(404);
    const j = (await r.json()) as { code: string };
    expect(j.code).toBe("NOT_FOUND");
  });

  test("GET /api/v1/place/:gid (miss → 404)", async () => {
    resetRateLimit();
    const r = await req("/api/v1/place/geonames:does-not-exist");
    expect(r.status).toBe(404);
    const j = (await r.json()) as { code: string };
    expect(j.code).toBe("NOT_FOUND");
  });

  test("GET /api/v1/countries", async () => {
    resetRateLimit();
    const r = await req("/api/v1/countries");
    expect(r.status).toBe(200);
    const j = (await r.json()) as { total: number };
    expect(j.total).toBe(3);
  });

  test("GET /api/v1/countries/de", async () => {
    resetRateLimit();
    const r = await req("/api/v1/countries/de");
    expect(r.status).toBe(200);
    expect(((await r.json()) as { name: string }).name).toBe("Germany");
  });

  test("GET /api/v1/postal?code=10115", async () => {
    resetRateLimit();
    const r = await req("/api/v1/postal?code=10115");
    expect(r.status).toBe(200);
    const j = (await r.json()) as {
      postal_codes: { place_name: string }[];
    };
    expect(j.postal_codes[0]?.place_name).toBe("Berlin Mitte");
  });

  test("GET /api/v1/coverage", async () => {
    resetRateLimit();
    const r = await req("/api/v1/coverage");
    expect(r.status).toBe(200);
    const j = (await r.json()) as { countries: Record<string, string> };
    expect(j.countries["DE"]).toBe("address");
    expect(j.countries["FR"]).toBe("none");
  });

  test("POST /api/v1/batch", async () => {
    resetRateLimit();
    const r = await req("/api/v1/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entries: [
          { type: "search", q: "berlin", limit: 1 },
          { type: "reverse", lat: 52.52, lng: 13.41, limit: 1 },
        ],
      }),
    });
    expect(r.status).toBe(200);
    const j = (await r.json()) as {
      results: { features: { name: string }[] }[];
    };
    expect(j.results.length).toBe(2);
  });
});

describe("/geo routes — validation errors return ErrorSchema", () => {
  test("invalid layer → 400 BAD_INPUT", async () => {
    resetRateLimit();
    const r = await req("/api/v1/search?q=x&layers=garbage");
    expect(r.status).toBe(400);
    const j = (await r.json()) as { code: string; error: string };
    expect(j.code).toBe("BAD_INPUT");
    expect(j.error).toContain("validation failed");
  });

  test("empty proximity_lat → 400", async () => {
    resetRateLimit();
    const r = await req("/api/v1/search?q=x&proximity_lat=");
    expect(r.status).toBe(400);
    expect(((await r.json()) as { code: string }).code).toBe("BAD_INPUT");
  });

  test("missing q → 400", async () => {
    resetRateLimit();
    const r = await req("/api/v1/search");
    expect(r.status).toBe(400);
  });

  test("country regex mismatch → 400", async () => {
    resetRateLimit();
    const r = await req("/api/v1/countries/abc");
    expect(r.status).toBe(400);
  });

  test("postal without code or place → 400", async () => {
    resetRateLimit();
    const r = await req("/api/v1/postal");
    expect(r.status).toBe(400);
  });

  test("batch without Content-Type → 400", async () => {
    resetRateLimit();
    const r = await req("/api/v1/batch", {
      method: "POST",
      body: JSON.stringify({ entries: [{ type: "search", q: "x" }] }),
    });
    expect(r.status).toBe(400);
  });

  test("batch with empty entries → 400", async () => {
    resetRateLimit();
    const r = await req("/api/v1/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries: [] }),
    });
    expect(r.status).toBe(400);
  });
});

describe("/geo routes — schema boundaries", () => {
  test("q longer than 200 chars → 400", async () => {
    resetRateLimit();
    const long = "a".repeat(201);
    const r = await req(`/api/v1/search?q=${encodeURIComponent(long)}`);
    expect(r.status).toBe(400);
  });

  test("inverted bbox → 400", async () => {
    resetRateLimit();
    // minLng > maxLng
    const r = await req("/api/v1/search?q=x&bbox=20,40,10,50");
    expect(r.status).toBe(400);
  });

  test("bbox out of range → 400", async () => {
    resetRateLimit();
    const r = await req("/api/v1/search?q=x&bbox=-200,40,10,50");
    expect(r.status).toBe(400);
  });

  test("only proximity_lat without proximity_lng → 400", async () => {
    resetRateLimit();
    const r = await req("/api/v1/search?q=x&proximity_lat=52.5");
    expect(r.status).toBe(400);
  });

  test("reverse out-of-range lat → 400", async () => {
    resetRateLimit();
    const r = await req("/api/v1/reverse?lat=91&lng=13");
    expect(r.status).toBe(400);
  });

  test("reverse missing lng → 400", async () => {
    resetRateLimit();
    const r = await req("/api/v1/reverse?lat=52");
    expect(r.status).toBe(400);
  });

  test("limit=0 → 400", async () => {
    resetRateLimit();
    const r = await req("/api/v1/search?q=x&limit=0");
    expect(r.status).toBe(400);
  });

  test("limit=999 → 400", async () => {
    resetRateLimit();
    const r = await req("/api/v1/search?q=x&limit=999");
    expect(r.status).toBe(400);
  });

  test("batch > 100 entries → 400", async () => {
    resetRateLimit();
    const entries = Array.from({ length: 101 }, () => ({
      type: "search" as const,
      q: "x",
    }));
    const r = await req("/api/v1/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries }),
    });
    expect(r.status).toBe(400);
  });

  test("batch entry with bad type → 400", async () => {
    resetRateLimit();
    const r = await req("/api/v1/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries: [{ type: "garbage", q: "x" }] }),
    });
    expect(r.status).toBe(400);
  });
});

describe("rate limit (Traefik-aware via X-Forwarded-For)", () => {
  test("60 OK then 5 × 429 from same XFF", async () => {
    resetRateLimit();
    const headers = { "X-Forwarded-For": "203.0.113.42" };
    let okCount = 0;
    let throttled = 0;
    for (let i = 0; i < 65; i++) {
      const r = await req("/api/v1/coverage", { headers });
      if (r.status === 200) okCount++;
      else if (r.status === 429) throttled++;
    }
    expect(okCount).toBe(60);
    expect(throttled).toBe(5);
  });

  test("different XFF IP not throttled", async () => {
    resetRateLimit();
    // exhaust IP A
    for (let i = 0; i < 65; i++) {
      await req("/api/v1/coverage", { headers: { "X-Forwarded-For": "203.0.113.1" } });
    }
    // IP B should be unaffected
    const r = await req("/api/v1/coverage", {
      headers: { "X-Forwarded-For": "203.0.113.2" },
    });
    expect(r.status).toBe(200);
  });

  test("429 response has Retry-After + RateLimit headers", async () => {
    resetRateLimit();
    const headers = { "X-Forwarded-For": "203.0.113.99" };
    let r: Response | null = null;
    for (let i = 0; i < 65; i++) {
      r = await req("/api/v1/coverage", { headers });
      if (r.status === 429) break;
    }
    expect(r?.status).toBe(429);
    expect(r?.headers.get("Retry-After")).toBeTruthy();
    expect(r?.headers.get("X-RateLimit-Limit")).toBe("60");
    expect(r?.headers.get("X-RateLimit-Remaining")).toBe("0");
    const j = (await r!.json()) as { code: string };
    expect(j.code).toBe("RATE_LIMIT");
  });
});

describe("OpenAPI + docs", () => {
  test("/api/v1/openapi.json lists all /geo paths with 401/429/500", async () => {
    resetRateLimit();
    const r = await req("/api/v1/openapi.json");
    expect(r.status).toBe(200);
    const spec = (await r.json()) as {
      openapi: string;
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
    };
    expect(spec.openapi).toBeDefined();
    const expected = [
      "/api/v1/search",
      "/api/v1/reverse",
      "/api/v1/place/{gid}",
      "/api/v1/code/{kind}/{value}",
      "/api/v1/countries",
      "/api/v1/countries/{code}",
      "/api/v1/postal",
      "/api/v1/coverage",
      "/api/v1/batch",
    ];
    for (const p of expected) {
      expect(spec.paths[p]).toBeDefined();
      const op = Object.values(spec.paths[p]!)[0]!;
      expect(op.responses["401"]).toBeDefined();
      expect(op.responses["429"]).toBeDefined();
      expect(op.responses["500"]).toBeDefined();
    }
  });

  test("/api/v1/docs renders Scalar HTML", async () => {
    resetRateLimit();
    const r = await req("/api/v1/docs");
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html.toLowerCase()).toContain("scalar");
  });

  test("/api/v1/llms.txt is non-empty markdown", async () => {
    resetRateLimit();
    const r = await req("/api/v1/llms.txt");
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text.length).toBeGreaterThan(100);
  });
});

describe("404 + error envelope", () => {
  test("unknown path returns ErrorSchema 404", async () => {
    resetRateLimit();
    const r = await req("/totally-unknown");
    expect(r.status).toBe(404);
    const j = (await r.json()) as { code: string };
    expect(j.code).toBe("NOT_FOUND");
  });
});
