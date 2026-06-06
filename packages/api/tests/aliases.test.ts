import { afterAll, describe, expect, test } from "bun:test";
import { spawnTestDb, setDatabaseUrl } from "./lib/testdb";
import { seedDataset } from "./lib/seed";

const db = await spawnTestDb();
setDatabaseUrl(db.url);
const { sql } = await import("bun");
const { migrate } = await import("../src/migrate");
const { service } = await import("../src/service");
await migrate();
const seed = await seedDataset({ aliases: true });

afterAll(async () => {
  seed.stop();
  await sql.end().catch(() => {});
  await db.stop();
});

const baseSearch = (overrides = {}) => ({
  q: "",
  layers: undefined as ("address" | "locality")[] | undefined,
  country: undefined as string | undefined,
  proximity_lat: undefined as number | undefined,
  proximity_lng: undefined as number | undefined,
  bbox: undefined,
  limit: 5,
  ...overrides,
});

describe("aliases ingest", () => {
  test("loads expected row counts", async () => {
    const [row] = await sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM geomark.place_aliases
    `;
    // Fixture has 23 rows (excluding header): 8 Berlin, 10 Munich, 5 NYC.
    expect(row?.n).toBe(23);
  });

  test("search_text generated only for kind in (name, abbr)", async () => {
    const [withSt] = await sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM geomark.place_aliases WHERE search_text IS NOT NULL
    `;
    const [withoutSt] = await sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM geomark.place_aliases
      WHERE search_text IS NULL AND kind NOT IN ('name','abbr')
    `;
    expect((withSt?.n ?? 0) > 0).toBe(true);
    expect((withoutSt?.n ?? 0) > 0).toBe(true);
  });
});

describe("search via aliases", () => {
  test('"münchen" finds Munich (matched_alias.lang=de) — primary UX win', async () => {
    const r = await service.search(baseSearch({ q: "münchen" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const munich = r.data.features.find((f) => f.gid === "geonames:2867714");
    expect(munich).toBeDefined();
    expect(munich!.matched_alias).toBeDefined();
    expect(munich!.matched_alias!.lang).toBe("de");
    expect(munich!.matched_alias!.value).toBe("München");
  });

  test('Japanese name "ベルリン" finds Berlin', async () => {
    const r = await service.search(baseSearch({ q: "ベルリン" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.features.some((f) => f.gid === "geonames:2950159")).toBe(true);
  });

  test('Italian "Monaco di Baviera" finds Munich (multilingual)', async () => {
    const r = await service.search(baseSearch({ q: "Monaco di Baviera" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const munich = r.data.features.find((f) => f.gid === "geonames:2867714");
    expect(munich).toBeDefined();
    expect(munich!.matched_alias?.lang).toBe("it");
  });

  test("direct-name hit beats alias hit on same gid (no matched_alias)", async () => {
    // "Munich" is the canonical name AND an en-alias. Direct must win.
    const r = await service.search(baseSearch({ q: "Munich" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const munich = r.data.features.find((f) => f.gid === "geonames:2867714");
    expect(munich).toBeDefined();
    expect(munich!.matched_alias).toBeUndefined();
  });

  test("prefer_lang=de localizes name + label of Munich to München", async () => {
    const r = await service.search(baseSearch({ q: "Munich", prefer_lang: "de" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const munich = r.data.features.find((f) => f.gid === "geonames:2867714");
    expect(munich).toBeDefined();
    expect(munich!.name).toBe("München");
    expect(munich!.label).toBe("München");
  });

  test("prefer_lang has no effect when no alias for that lang exists", async () => {
    // Lübeck has no DE alias in fixtures → name stays canonical "Lübeck".
    const r = await service.search(baseSearch({ q: "Lübeck", prefer_lang: "ja" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const lubeck = r.data.features.find((f) => f.name === "Lübeck");
    expect(lubeck).toBeDefined();
  });
});

describe("/place/:gid hydrates aliases", () => {
  test("Munich returns full aliases array", async () => {
    const r = await service.place.get("geonames:2867714");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.place.name).toBe("Munich");
    expect(r.data.aliases.length).toBeGreaterThan(5);

    const de = r.data.aliases.find(
      (a) => a.kind === "name" && a.lang === "de",
    );
    expect(de?.value).toBe("München");
    expect(de?.is_preferred).toBe(true);

    const iata = r.data.aliases.find((a) => a.kind === "iata");
    expect(iata?.value).toBe("MUC");
    expect(iata?.lang).toBeNull();

    const link = r.data.aliases.find((a) => a.kind === "link");
    expect(link?.value).toContain("wikipedia");
  });

  test("place without aliases gets empty array", async () => {
    // Lübeck has no aliases in fixtures.
    const r = await service.place.get("geonames:2879139");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.aliases).toEqual([]);
  });
});

describe("/code/:kind/:value reverse lookup", () => {
  test("IATA MUC → Munich", async () => {
    const r = await service.code.lookup("iata", "MUC");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.gid).toBe("geonames:2867714");
    expect(r.data.name).toBe("Munich");
  });

  test("ICAO EDDB → Berlin (case-insensitive)", async () => {
    const r = await service.code.lookup("icao", "eddb");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.gid).toBe("geonames:2950159");
  });

  test("abbr NYC → New York City", async () => {
    const r = await service.code.lookup("abbr", "NYC");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.name).toBe("New York City");
  });

  test("404 on unknown code", async () => {
    const r = await service.code.lookup("iata", "ZZZ");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.status).toBe(404);
  });
});
