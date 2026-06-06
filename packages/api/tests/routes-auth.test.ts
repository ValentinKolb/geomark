import { afterAll, describe, expect, test } from "bun:test";
import { spawnTestDb, setDatabaseUrl } from "./lib/testdb";
import { seedDataset } from "./lib/seed";

// Set API_KEY *before* importing config / createApp. Each Bun test file
// runs in its own process, so this env mutation doesn't leak between
// tests files.
process.env.API_KEY = "test-secret-token";

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

describe("/api/v1/* with API_KEY configured", () => {
  test("missing Authorization header → 401 with ErrorSchema body", async () => {
    resetRateLimit();
    const r = await req("/api/v1/coverage");
    expect(r.status).toBe(401);
    const j = (await r.json()) as { error: string; code: string };
    expect(j.code).toBe("UNAUTHORIZED");
    expect(j.error).toContain("missing");
  });

  test("malformed Authorization header → 400 ErrorSchema body", async () => {
    resetRateLimit();
    const r = await req("/api/v1/coverage", {
      headers: { Authorization: "NotBearer xyz" },
    });
    expect(r.status).toBe(400);
    const j = (await r.json()) as { code: string };
    expect(j.code).toBe("UNAUTHORIZED");
  });

  test("invalid Bearer token → 401 ErrorSchema body", async () => {
    resetRateLimit();
    const r = await req("/api/v1/coverage", {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(r.status).toBe(401);
    const j = (await r.json()) as { error: string; code: string };
    expect(j.code).toBe("UNAUTHORIZED");
    expect(j.error).toContain("invalid");
  });

  test("valid Bearer token → 200 success", async () => {
    resetRateLimit();
    const r = await req("/api/v1/coverage", {
      headers: { Authorization: "Bearer test-secret-token" },
    });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { countries: Record<string, string> };
    expect(j.countries["DE"]).toBe("address");
  });

  test("rate-limit applies to UNAUTH'd probes (auth comes after rateLimit)", async () => {
    resetRateLimit();
    // 65 unauthenticated requests — auth would 401 immediately without
    // rateLimit. Since rateLimit runs FIRST, requests 61-65 must 429.
    let throttled = 0;
    for (let i = 0; i < 65; i++) {
      const r = await req("/api/v1/coverage", {
        headers: { "X-Forwarded-For": "203.0.113.7" },
      });
      if (r.status === 429) throttled++;
    }
    expect(throttled).toBe(5);
  });

  test("/health stays public (no auth)", async () => {
    resetRateLimit();
    const r = await req("/health");
    expect(r.status).toBe(200);
  });

  test("/ready stays public (no auth)", async () => {
    resetRateLimit();
    const r = await req("/ready");
    expect(r.status).toBe(200);
  });

  test("/api/v1/openapi.json stays public", async () => {
    resetRateLimit();
    const r = await req("/api/v1/openapi.json");
    expect(r.status).toBe(200);
  });
});
