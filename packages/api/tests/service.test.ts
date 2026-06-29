import { afterAll, describe, expect, test } from "bun:test";
import { spawnTestDb, setDatabaseUrl } from "./lib/testdb";
import { seedDataset } from "./lib/seed";

const db = await spawnTestDb();
setDatabaseUrl(db.url);
const { sql } = await import("bun");
const { migrate } = await import("../src/migrate");
const { service } = await import("../src/service");
await migrate();
const seed = await seedDataset();

afterAll(async () => {
  seed.stop();
  await sql.end().catch(() => {});
  await db.stop();
});

const baseSearch = (overrides: Partial<{
  q: string;
  layers: ("address" | "locality")[];
  country: string;
  proximity_lat: number;
  proximity_lng: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  bbox: any;
  limit: number;
}> = {}) => ({
  q: "berlin",
  layers: undefined,
  country: undefined,
  proximity_lat: undefined,
  proximity_lng: undefined,
  bbox: undefined,
  limit: 10,
  ...overrides,
});

const baseReverse = (lat: number, lng: number, overrides = {}) => ({
  lat, lng, layers: undefined,
  radius: undefined, limit: 10, ...overrides,
});

describe("search — hybrid BM25 + trigram", () => {
  test("BM25 exact match wins (Berlin > Berliner Straße)", async () => {
    const r = await service.search(baseSearch({ q: "berlin" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.features[0]?.name).toBe("Berlin");
    const namesByOrder = r.data.features.map((f: { name: string }) => f.name);
    expect(namesByOrder.indexOf("Berlin")).toBeLessThan(
      namesByOrder.indexOf("Berliner Straße"),
    );
  });

  test("trigram fuzzy fallback for typos ('munic' → Munich)", async () => {
    // service.test.ts seeds without aliases — canonical-name match only.
    // German "münchen" → Munich is exercised in tests/aliases.test.ts.
    const r = await service.search(baseSearch({ q: "munic" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.features[0]?.name).toBe("Munich");
  });

  test("unaccent fuzzy ('lubeck' → Lübeck)", async () => {
    const r = await service.search(baseSearch({ q: "lubeck" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.features[0]?.name).toBe("Lübeck");
  });

  test("layer filter — addresses only", async () => {
    const r = await service.search(baseSearch({ q: "berlin", layers: ["address"] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const f of r.data.features) {
      expect(f.layer).toBe("address");
    }
  });

  test("country filter — only US results", async () => {
    const r = await service.search(baseSearch({ q: "broadway", country: "US" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.features.length).toBeGreaterThan(0);
    for (const f of r.data.features) {
      expect(f.country_code).toBe("US");
    }
  });

  test("proximity adds distance_km + acts as tiebreaker", async () => {
    const r = await service.search(
      baseSearch({
        q: "berlin",
        proximity_lat: 52.52,
        proximity_lng: 13.41,
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.features[0]?.distance_km).toBeDefined();
    expect(r.data.features[0]?.distance_km).toBeLessThan(1);
  });

  test("bbox filter restricts to envelope", async () => {
    const r = await service.search(
      baseSearch({
        q: "berlin",
        bbox: { minLng: 13.0, minLat: 52.0, maxLng: 14.0, maxLat: 53.0 },
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const f of r.data.features) {
      expect(f.longitude).toBeGreaterThanOrEqual(13.0);
      expect(f.longitude).toBeLessThanOrEqual(14.0);
      expect(f.latitude).toBeGreaterThanOrEqual(52.0);
      expect(f.latitude).toBeLessThanOrEqual(53.0);
    }
  });

  test("empty query returns empty (no SQL)", async () => {
    const r = await service.search(baseSearch({ q: "   " }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.features).toEqual([]);
  });

  test("limit caps results", async () => {
    const r = await service.search(baseSearch({ q: "e", limit: 2 }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.features.length).toBeLessThanOrEqual(2);
  });
});

describe("reverse", () => {
  test("nearest first by distance", async () => {
    const r = await service.reverse(baseReverse(52.524, 13.410));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.features[0]?.distance_km).toBeLessThan(0.1);
    // Distances must be monotonically non-decreasing
    let prev = 0;
    for (const f of r.data.features) {
      const d = f.distance_km ?? 0;
      expect(d).toBeGreaterThanOrEqual(prev);
      prev = d;
    }
  });

  test("radius cuts off far results", async () => {
    const r = await service.reverse(
      baseReverse(52.524, 13.410, { radius: 0.1, limit: 100 }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const f of r.data.features) {
      expect(f.distance_km ?? 0).toBeLessThanOrEqual(0.1);
    }
  });

  test("layer filter (locality only)", async () => {
    const r = await service.reverse(
      baseReverse(52.524, 13.410, { layers: ["locality"] }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const f of r.data.features) {
      expect(f.layer).toBe("locality");
    }
  });

  test("score is a normalized closeness", async () => {
    const r = await service.reverse(baseReverse(52.524, 13.410));
    if (!r.ok) return;
    const score = r.data.features[0]?.score ?? 0;
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  test("high-latitude correctness: east candidate within sphere radius is found", async () => {
    // Insert 4 places around lat 70° (northern Norway): two due east+west
    // within 5km, two due north+south. Symmetric in sphere meters but
    // asymmetric in degrees — at this lat 1° lon ≈ 38km, 1° lat ≈ 111km.
    // The buggy degRadius × 1.5 would clip east/west candidates.
    const lat = 70;
    const lng = 25;
    const meterToDegLat = 1 / 111320;
    const cosLat = Math.cos((lat * Math.PI) / 180);
    const r4kmInLatDeg = 4000 * meterToDegLat;
    const r4kmInLngDeg = (4000 * meterToDegLat) / cosLat;
    await sql`
      INSERT INTO geomark.places (gid, name, latitude, longitude)
      VALUES
        ('test:hi-east',  'Eastpoint',  ${lat}, ${lng + r4kmInLngDeg}),
        ('test:hi-west',  'Westpoint',  ${lat}, ${lng - r4kmInLngDeg}),
        ('test:hi-north', 'Northpoint', ${lat + r4kmInLatDeg}, ${lng}),
        ('test:hi-south', 'Southpoint', ${lat - r4kmInLatDeg}, ${lng})
      ON CONFLICT (gid) DO NOTHING
    `;
    try {
      const r = await service.reverse(
        baseReverse(lat, lng, { radius: 5, limit: 4, layers: ["locality"] }),
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const names = new Set(r.data.features.map((f) => f.name));
      expect(names.has("Eastpoint")).toBe(true);
      expect(names.has("Westpoint")).toBe(true);
      expect(names.has("Northpoint")).toBe(true);
      expect(names.has("Southpoint")).toBe(true);
    } finally {
      await sql`DELETE FROM geomark.places WHERE gid LIKE 'test:hi-%'`;
    }
  });
});

describe("place.get", () => {
  test("hit", async () => {
    const r = await service.place.get("geonames:2950159");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.place.name).toBe("Berlin");
    expect(r.data.place.population).toBe(3645000);
    expect(r.data.place.timezone).toBe("Europe/Berlin");
    expect(r.data.aliases).toEqual([]); // no aliases dataset in this test
  });

  test("404 on miss", async () => {
    const r = await service.place.get("geonames:does-not-exist");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.status).toBe(404);
    expect(r.error.code).toBe("NOT_FOUND");
  });
});

describe("postal.query", () => {
  test("by code", async () => {
    const r = await service.postal.query({ code: "10115", place: undefined, country: undefined, limit: 10 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.postal_codes[0]?.place_name).toBe("Berlin Mitte");
  });

  test("by place fuzzy (trgm)", async () => {
    const r = await service.postal.query({ code: undefined, place: "berln mitte", country: undefined, limit: 10 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.postal_codes.length).toBeGreaterThan(0);
  });

  test("country filter", async () => {
    const r = await service.postal.query({ code: undefined, place: "berlin", country: "DE", limit: 10 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const p of r.data.postal_codes) {
      expect(p.country_code).toBe("DE");
    }
  });

  test("BAD_INPUT when neither code nor place", async () => {
    const r = await service.postal.query({ code: undefined, place: undefined, country: undefined, limit: 10 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("BAD_INPUT");
  });
});

describe("countries", () => {
  test("list returns all 3 with place_count", async () => {
    const r = await service.country.list();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.total).toBe(3);
    const de = r.data.countries.find((c: { code: string }) => c.code === "DE");
    expect(de).toBeDefined();
    expect(de!.place_count).toBe(4); // Berlin, München, Berliner Straße, Lübeck
    expect(de!.languages).toEqual(["de"]);
  });

  test("get by code (lowercase normalized)", async () => {
    const r = await service.country.get("us");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.code).toBe("US");
    expect(r.data.name).toBe("United States");
    expect(r.data.languages).toEqual(["en-US", "es-US", "haw"]);
  });

  test("404 on unknown code", async () => {
    const r = await service.country.get("XY");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.status).toBe(404);
  });
});

describe("coverage", () => {
  test("classifies countries by deepest available layer", async () => {
    const r = await service.coverage.get();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.countries["DE"]).toBe("address");
    expect(r.data.countries["US"]).toBe("address");
    expect(r.data.countries["FR"]).toBe("none");
  });
});

describe("random", () => {
  test("returns bounded indexed samples", async () => {
    const r = await service.random({
      limit: 3,
      country: undefined,
      min_population: undefined,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.total).toBeLessThanOrEqual(3);
    expect(r.data.places.length).toBe(r.data.total);
    expect(r.data.places.length).toBeGreaterThan(0);
  });

  test("honors country and population filters", async () => {
    const r = await service.random({
      limit: 10,
      country: "DE",
      min_population: 1_000_000,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.places.length).toBeGreaterThan(0);
    for (const place of r.data.places) {
      expect(place.country_code).toBe("DE");
      expect(place.population ?? 0).toBeGreaterThanOrEqual(1_000_000);
    }
  });

  test("does not use full-table ORDER BY random", async () => {
    const source = await Bun.file(
      new URL("../src/service/random.ts", import.meta.url),
    ).text();
    expect(source.toLowerCase()).not.toContain("order by random()");
  });
});

describe("batch", () => {
  test("mixed search + reverse", async () => {
    const r = await service.batch.run({
      entries: [
        { type: "search", q: "berlin", limit: 1 },
        { type: "reverse", lat: 52.524, lng: 13.410, limit: 1 },
        { type: "search", q: "san francisco", country: "US", limit: 1 },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.results.length).toBe(3);
    expect(r.data.results[0]?.features[0]?.name).toBe("Berlin");
    expect(r.data.results[2]?.features[0]?.country_code).toBe("US");
  });
});
