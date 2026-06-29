import { afterAll, describe, expect, test } from "bun:test";
import { spawnTestDb, setDatabaseUrl } from "./lib/testdb";

// Module-level setup. Top-level await runs before any test; this avoids
// Bun's `beforeAll` ignoring HookOptions for hook timeouts.
const db = await spawnTestDb();
setDatabaseUrl(db.url);
const { sql } = await import("bun");
const { migrate } = await import("../src/migrate");

afterAll(async () => {
  await sql.end().catch(() => {});
  await db.stop();
});

describe("migrate", () => {
  test("first run applies cleanly", async () => {
    await migrate();
    const exts = await sql<{ extname: string }[]>`
      SELECT extname FROM pg_extension
      WHERE extname IN ('postgis','pg_trgm','unaccent','pg_textsearch')
      ORDER BY extname
    `;
    expect(exts.map((e: { extname: string }) => e.extname)).toEqual([
      "pg_textsearch",
      "pg_trgm",
      "postgis",
      "unaccent",
    ]);
  });

  test("second run is idempotent", async () => {
    await migrate();
    await migrate();
    const tables = await sql<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'geomark'
      ORDER BY tablename
    `;
    expect(tables.map((t: { tablename: string }) => t.tablename)).toEqual([
      "addresses",
      "countries",
      "coverage",
      "meta",
      "place_aliases",
      "places",
      "postal_codes",
    ]);
  });

  test("expected indexes exist", async () => {
    const idx = await sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'geomark'
      ORDER BY indexname
    `;
    const names = idx.map((i: { indexname: string }) => i.indexname);
    expect(names).toContain("idx_places_search_bm25");
    expect(names).toContain("idx_places_search_trgm");
    expect(names).toContain("idx_addresses_search_bm25");
    expect(names).toContain("idx_addresses_search_trgm");
    expect(names).toContain("idx_places_geom");
    expect(names).toContain("idx_places_sample_key");
    expect(names).toContain("idx_places_country_sample_key");
    expect(names).toContain("idx_addresses_geom");
    expect(names).toContain("idx_postal_geom");
    expect(names).toContain("idx_postal_place_trgm");
    // alias indexes
    expect(names).toContain("idx_aliases_geonameid");
    expect(names).toContain("idx_aliases_kind_value");
    expect(names).toContain("idx_aliases_prefer_lang");
    expect(names).toContain("idx_aliases_search_trgm");
    expect(names).toContain("idx_aliases_search_bm25");
  });

  test("f_unaccent normalizes umlauts", async () => {
    const [row] = await sql<{ s: string }[]>`
      SELECT geomark.f_unaccent(lower('Müllerstraße')) AS s
    `;
    expect(row?.s).toBe("mullerstrasse");
  });

  test("places geom/search_text/sample_key are auto-computed", async () => {
    await sql`TRUNCATE geomark.places`;
    await sql`
      INSERT INTO geomark.places (gid, name, latitude, longitude)
      VALUES ('test:1', 'Lübeck', 53.86893, 10.68729)
    `;
    const [row] = await sql<
      {
        name: string;
        search_text: string;
        geom_wkt: string;
        sample_key: number;
      }[]
    >`
      SELECT name, search_text, ST_AsText(geom) AS geom_wkt, sample_key
      FROM geomark.places WHERE gid = 'test:1'
    `;
    expect(row?.search_text).toBe("lubeck");
    expect(row?.geom_wkt).toBe("POINT(10.68729 53.86893)");
    expect(row?.sample_key).toBeGreaterThanOrEqual(0);
    expect(row?.sample_key).toBeLessThan(1);
  });

  test("addresses.label NOT NULL + search_text generated", async () => {
    await sql`TRUNCATE geomark.addresses`;
    await sql`
      INSERT INTO geomark.addresses
        (gid, latitude, longitude, label)
      VALUES
        ('test:addr', 52.5, 13.4, '12 Müllerstraße, 10115 Berlin, DE')
    `;
    const [row] = await sql<{ search_text: string }[]>`
      SELECT search_text FROM geomark.addresses WHERE gid = 'test:addr'
    `;
    expect(row?.search_text).toBe("12 mullerstrasse, 10115 berlin, de");
  });

  test("postal_codes geom is NULL when lat/lng are NULL", async () => {
    await sql`TRUNCATE geomark.postal_codes`;
    await sql`
      INSERT INTO geomark.postal_codes (country_code, postal_code, place_name)
      VALUES ('XX', '0000', 'no-coords')
    `;
    const [row] = await sql<{ geom: unknown }[]>`
      SELECT geom FROM geomark.postal_codes WHERE postal_code = '0000'
    `;
    expect(row?.geom).toBeNull();
  });

  test("meta is a single-row table with id=TRUE seeded", async () => {
    const rows = await sql<
      { id: boolean; places_count: number; aliases_count: number }[]
    >`SELECT id, places_count, aliases_count FROM geomark.meta`;
    expect(rows.length).toBe(1);
    expect(rows[0]?.id).toBe(true);
    expect(rows[0]?.places_count).toBe(0);
    expect(rows[0]?.aliases_count).toBe(0);
  });
});
