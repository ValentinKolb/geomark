import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { spawnTestDb, setDatabaseUrl } from "./lib/testdb";
import { startMockDataServer } from "./lib/seed";

const db = await spawnTestDb();
setDatabaseUrl(db.url);
const { sql } = await import("bun");
const { migrate } = await import("../src/migrate");
const { ingestAll } = await import("../src/loader/ingest");
const { fetchManifest } = await import("../src/loader/manifest");
await migrate();

afterAll(async () => {
  await sql.end().catch(() => {});
  await db.stop();
});

beforeEach(async () => {
  // Reset state between tests so they're independent.
  await sql`
    TRUNCATE TABLE
      geomark.coverage, geomark.place_aliases,
      geomark.places, geomark.addresses,
      geomark.postal_codes, geomark.countries
    RESTART IDENTITY
  `;
  await sql`
    UPDATE geomark.meta SET
      dataset_version=NULL,
      manifest_sha256=NULL,
      loaded_at=NULL,
      places_count=0,
      addresses_count=0,
      postal_codes_count=0,
      countries_count=0,
      aliases_count=0
  `;
});

describe("manifest", () => {
  test("fetchManifest validates a good manifest", async () => {
    const mock = await startMockDataServer();
    try {
      const m = await fetchManifest(mock.baseUrl);
      expect(m.version).toBe(`test-${mock.fingerprint}`);
      expect(m.files.places.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(m.files.addresses).toHaveLength(2);
    } finally {
      mock.stop();
    }
  });

  test("fetchManifest rejects 404", async () => {
    const app = new Hono();
    app.get("/latest.json", (c) => c.json({ error: "nf" }, 404));
    const server = Bun.serve({ port: 0, fetch: app.fetch });
    try {
      await expect(
        fetchManifest(`http://localhost:${server.port}`),
      ).rejects.toThrow(/404/);
    } finally {
      server.stop(true);
    }
  });

  test("fetchManifest rejects invalid shape", async () => {
    const app = new Hono();
    app.get("/latest.json", (c) => c.json({ broken: true }));
    const server = Bun.serve({ port: 0, fetch: app.fetch });
    try {
      await expect(
        fetchManifest(`http://localhost:${server.port}`),
      ).rejects.toThrow(/invalid manifest/);
    } finally {
      server.stop(true);
    }
  });
});

describe("ingestAll happy path", () => {
  test("loads expected row counts", async () => {
    const mock = await startMockDataServer();
    try {
      const counts = await ingestAll(
        mock.baseUrl,
        mock.manifest,
        mock.fingerprint,
      );
      expect(counts).toEqual({
        places: 6,
        postal_codes: 5,
        countries: 3,
        addresses: 5,
        aliases: 0,
      });
    } finally {
      mock.stop();
    }
  });

  test("meta is updated atomically with data", async () => {
    const mock = await startMockDataServer();
    try {
      await ingestAll(mock.baseUrl, mock.manifest, mock.fingerprint);
      const [row] = await sql<
        {
          dataset_version: string;
          manifest_sha256: string;
          loaded_at: Date;
          places_count: number;
          addresses_count: number;
          postal_codes_count: number;
          countries_count: number;
          aliases_count: number;
        }[]
      >`
        SELECT
          dataset_version,
          manifest_sha256,
          loaded_at,
          places_count,
          addresses_count,
          postal_codes_count,
          countries_count,
          aliases_count
        FROM geomark.meta
      `;
      expect(row?.dataset_version).toBe(mock.manifest.version);
      expect(row?.manifest_sha256).toBe(mock.fingerprint);
      expect(row?.loaded_at).toBeInstanceOf(Date);
      expect(row?.places_count).toBe(6);
      expect(row?.addresses_count).toBe(5);
      expect(row?.postal_codes_count).toBe(5);
      expect(row?.countries_count).toBe(3);
      expect(row?.aliases_count).toBe(0);
    } finally {
      mock.stop();
    }
  });

  test("materializes reference read models", async () => {
    const mock = await startMockDataServer();
    try {
      await ingestAll(mock.baseUrl, mock.manifest, mock.fingerprint);
      const countries = await sql<{ code: string; place_count: number }[]>`
        SELECT code, place_count FROM geomark.countries ORDER BY code
      `;
      expect(countries).toEqual([
        { code: "DE", place_count: 4 },
        { code: "FR", place_count: 0 },
        { code: "US", place_count: 2 },
      ]);

      const coverage = await sql<{ country_code: string; status: string }[]>`
        SELECT country_code, status FROM geomark.coverage ORDER BY country_code
      `;
      expect(coverage).toEqual([
        { country_code: "DE", status: "address" },
        { country_code: "FR", status: "none" },
        { country_code: "US", status: "address" },
      ]);
    } finally {
      mock.stop();
    }
  });

  test("address label is composed by loader", async () => {
    const mock = await startMockDataServer();
    try {
      await ingestAll(mock.baseUrl, mock.manifest, mock.fingerprint);
      const [row] = await sql<{ label: string; search_text: string }[]>`
        SELECT label, search_text FROM geomark.addresses WHERE gid = 'oa:de:1'
      `;
      expect(row?.label).toContain("12 Müllerstraße");
      expect(row?.label).toContain("10115 Berlin");
      expect(row?.label).toContain("DE");
      expect(row?.search_text).toContain("mullerstrasse");
    } finally {
      mock.stop();
    }
  });

  test("country languages are stored as text[]", async () => {
    const mock = await startMockDataServer();
    try {
      await ingestAll(mock.baseUrl, mock.manifest, mock.fingerprint);
      const [row] = await sql<{ languages: string[] }[]>`
        SELECT languages FROM geomark.countries WHERE code = 'US'
      `;
      expect(row?.languages).toEqual(["en-US", "es-US", "haw"]);
    } finally {
      mock.stop();
    }
  });
});

describe("ingestAll atomic safety", () => {
  test("SHA mismatch throws BEFORE truncating", async () => {
    // Seed once
    const first = await startMockDataServer();
    try {
      await ingestAll(first.baseUrl, first.manifest, first.fingerprint);
    } finally {
      first.stop();
    }
    const before = await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM geomark.places`;
    expect(before[0]?.n).toBe(6);

    // Second mock with tampered SHA for places
    const second = await startMockDataServer();
    try {
      const tampered = {
        ...second.manifest,
        files: {
          ...second.manifest.files,
          places: { ...second.manifest.files.places, sha256: "0".repeat(64) },
        },
      };
      await expect(
        ingestAll(second.baseUrl, tampered, "fp-tampered"),
      ).rejects.toThrow(/sha256 mismatch/);
    } finally {
      second.stop();
    }

    // Original data must still be intact
    const after = await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM geomark.places`;
    expect(after[0]?.n).toBe(6);
  });

  test("missing required CSV header throws AND rolls back (data + meta intact)", async () => {
    // Step 1: seed a valid dataset so we have something to protect.
    const seed = await startMockDataServer();
    try {
      await ingestAll(seed.baseUrl, seed.manifest, seed.fingerprint);
    } finally {
      seed.stop();
    }
    const [seedMeta] = await sql<
      {
        dataset_version: string;
        manifest_sha256: string;
        loaded_at: Date;
      }[]
    >`SELECT dataset_version, manifest_sha256, loaded_at FROM geomark.meta`;
    expect(seedMeta?.dataset_version).toBe(seed.manifest.version);
    const placesBeforeBroken = await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM geomark.places`;
    expect(placesBeforeBroken[0]?.n).toBe(6);

    // Step 2: build a broken places shard (missing GEONAMEID).
    const broken =
      "name,latitude,longitude\n" +
      "Berlin,52.5,13.4\n";
    const compress = async (s: string): Promise<Uint8Array> => {
      const p = Bun.spawn(["zstd", "-q"], { stdin: "pipe", stdout: "pipe" });
      p.stdin.write(new TextEncoder().encode(s));
      await p.stdin.end();
      const b = new Uint8Array(await new Response(p.stdout).arrayBuffer());
      if ((await p.exited) !== 0) throw new Error("zstd failed");
      return b;
    };
    const sha256Hex = async (b: Uint8Array): Promise<string> => {
      const d = new Uint8Array(
        await crypto.subtle.digest("SHA-256", b as BufferSource),
      );
      let hex = "";
      for (const x of d) hex += x.toString(16).padStart(2, "0");
      return hex;
    };
    const placesBytes = await compress(broken);
    const sha = await sha256Hex(placesBytes);

    // Step 3: serve the broken shard, run broken ingest, expect throw.
    const mock = await startMockDataServer();
    try {
      const tampered = {
        ...mock.manifest,
        files: {
          ...mock.manifest.files,
          places: {
            filename: "broken.csv.zst",
            sha256: sha,
            size_bytes: placesBytes.byteLength,
            line_count: 2,
          },
        },
      };
      const customApp = new Hono();
      customApp.get("/latest.json", (c) => c.json(tampered));
      customApp.get("/broken.csv.zst", () => new Response(placesBytes as BodyInit, {
        headers: { "Content-Type": "application/zstd" },
      }));
      customApp.get("/:filename", async (c) => {
        const r = await fetch(`${mock.baseUrl}/${c.req.param("filename")}`);
        return new Response(await r.arrayBuffer(), {
          headers: { "Content-Type": "application/zstd" },
        });
      });
      const customServer = Bun.serve({ port: 0, fetch: customApp.fetch });
      try {
        await expect(
          ingestAll(`http://localhost:${customServer.port}`, tampered, "fp-broken"),
        ).rejects.toThrow(/missing required CSV header.*GEONAMEID/);
      } finally {
        customServer.stop(true);
      }
    } finally {
      mock.stop();
    }

    // Step 4: row counts AND meta must be unchanged after the failed ingest.
    const placesAfter = await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM geomark.places`;
    expect(placesAfter[0]?.n).toBe(6);
    const addrsAfter = await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM geomark.addresses`;
    expect(addrsAfter[0]?.n).toBe(5);
    const [metaAfter] = await sql<
      { dataset_version: string; manifest_sha256: string; loaded_at: Date }[]
    >`SELECT dataset_version, manifest_sha256, loaded_at FROM geomark.meta`;
    expect(metaAfter?.dataset_version).toBe(seed.manifest.version);
    expect(metaAfter?.manifest_sha256).toBe(seed.fingerprint);
    expect(metaAfter?.loaded_at?.getTime()).toBe(seedMeta?.loaded_at?.getTime());
  });
});
