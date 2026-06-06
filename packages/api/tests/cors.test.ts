import { afterAll, describe, expect, test } from "bun:test";
import { spawnTestDb, setDatabaseUrl } from "./lib/testdb";
import { seedDataset } from "./lib/seed";

const db = await spawnTestDb();
setDatabaseUrl(db.url);
const { sql } = await import("bun");
const { migrate } = await import("../src/migrate");
await migrate();
const seed = await seedDataset();
const { createApp } = await import("../src/app");
const { app } = await createApp();

const req = (path: string, init?: RequestInit) =>
  app.fetch(new Request(`http://localhost${path}`, init));

afterAll(async () => {
  seed.stop();
  await sql.end().catch(() => {});
  await db.stop();
});

// CORS contract: the API is intentionally open — any origin, any method we
// expose, the Authorization + Content-Type headers permitted. We don't use
// cookies, so `origin: *` is fine (credentials:include is incompatible with
// it anyway). Preflight responses cached for a day.

describe("CORS", () => {
  test("simple GET → Access-Control-Allow-Origin: *", async () => {
    const r = await req("/v1/coverage", {
      headers: { Origin: "https://random.example.com" },
    });
    expect(r.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  test("preflight OPTIONS → exposes allowed methods + headers", async () => {
    const r = await req("/v1/search", {
      method: "OPTIONS",
      headers: {
        Origin: "https://random.example.com",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "Authorization, Content-Type",
      },
    });
    expect(r.status).toBeLessThan(300);
    expect(r.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const methods = r.headers.get("Access-Control-Allow-Methods") ?? "";
    expect(methods).toContain("GET");
    expect(methods).toContain("POST");
    const headers = r.headers.get("Access-Control-Allow-Headers") ?? "";
    expect(headers.toLowerCase()).toContain("authorization");
  });

  test("preflight caches for a day", async () => {
    const r = await req("/v1/search", {
      method: "OPTIONS",
      headers: {
        Origin: "https://x.example.com",
        "Access-Control-Request-Method": "GET",
      },
    });
    expect(r.headers.get("Access-Control-Max-Age")).toBe("86400");
  });

  test("CORS headers present on /health (ops endpoint, still open)", async () => {
    const r = await req("/health", {
      headers: { Origin: "https://uptime-checker.example.com" },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});
