#!/usr/bin/env bun
/**
 * Smoke test for the service layer. Loads a synthetic dataset via the
 * loader then exercises each service function against it.
 *
 *   docker run -d --rm --name pg ... timescale/timescaledb-ha:pg17-all
 *   DATABASE_URL=postgres://... DATA_URL=http://localhost:19997 \
 *     bun packages/api/scripts/smoke-service.ts
 */
import { sql } from "bun";
import { Hono } from "hono";
import { migrate } from "../src/migrate";
import { setupLoader, stopLoader } from "../src/loader";
import { service } from "../src/service";

const PORT = 19997;

// ─── synthetic data — bigger than smoke-loader so search ranking is meaningful ─

const PLACES_CSV = [
  "geonameid,name,asciiname,latitude,longitude,feature_class,feature_code,country_code,admin1_code,admin2_code,population,elevation,timezone",
  "2950159,Berlin,Berlin,52.52437,13.41053,P,PPLC,DE,16,00,3645000,34,Europe/Berlin",
  "2867714,München,Muenchen,48.13743,11.57549,P,PPLA,DE,02,,1471000,520,Europe/Berlin",
  "2944388,Berliner Straße,Berliner Strasse,52.50000,13.40000,P,PPL,DE,16,00,1000,30,Europe/Berlin",
  "2879139,Lübeck,Luebeck,53.86893,10.68729,P,PPL,DE,01,,217198,15,Europe/Berlin",
  "5128581,New York City,New York City,40.71427,-74.00597,P,PPL,US,NY,061,8175133,10,America/New_York",
  "5391959,San Francisco,San Francisco,37.77493,-122.41942,P,PPLA2,US,CA,075,864816,16,America/Los_Angeles",
].join("\n") + "\n";

const POSTAL_CSV = [
  "country_code,postal_code,place_name,admin_name1,admin_code1,latitude,longitude",
  "DE,10115,Berlin Mitte,Berlin,16,52.5326,13.3850",
  "DE,80331,München Altstadt,Bayern,02,48.1374,11.5755",
  "DE,23552,Lübeck,Schleswig-Holstein,01,53.866,10.687",
  "US,10004,New York,New York,NY,40.6993,-74.0156",
  "US,94115,San Francisco,California,CA,37.7858,-122.4378",
].join("\n") + "\n";

const COUNTRIES_CSV = [
  "code,code3,name,capital,continent,currency_code,languages,calling_code,flag_emoji",
  "DE,DEU,Germany,Berlin,EU,EUR,de,49,🇩🇪",
  "US,USA,United States,Washington,NA,USD,en-US;es-US;haw,1,🇺🇸",
  "FR,FRA,France,Paris,EU,EUR,fr-FR;frp;br,33,🇫🇷",
].join("\n") + "\n";

const ADDR_DE_CSV = [
  "gid,latitude,longitude,house_number,street,unit,city,postcode,region,country_code",
  "oa:de:1,52.52437,13.41053,12,Müllerstraße,,Berlin,10115,Berlin,DE",
  "oa:de:2,52.51000,13.42000,5,Friedrichstraße,,Berlin,10117,Berlin,DE",
  "oa:de:3,48.13700,11.57500,7a,Marienplatz,,München,80331,Bayern,DE",
].join("\n") + "\n";

const ADDR_US_CSV = [
  "gid,latitude,longitude,house_number,street,unit,city,postcode,region,country_code",
  "oa:us:1,40.71427,-74.00597,1,Broadway,,New York,10004,NY,US",
  "oa:us:2,37.77493,-122.41942,2300,Fillmore St,Apt 3,San Francisco,94115,CA,US",
].join("\n") + "\n";

// ─── helpers ─────────────────────────────────────────────────────────────────

const zstdCompress = async (data: string): Promise<Uint8Array> => {
  const proc = Bun.spawn(["zstd", "-q"], { stdin: "pipe", stdout: "pipe" });
  proc.stdin.write(new TextEncoder().encode(data));
  await proc.stdin.end();
  const out = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
  if ((await proc.exited) !== 0) throw new Error("zstd compress failed");
  return out;
};
const sha256Hex = async (b: Uint8Array): Promise<string> => {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", b as BufferSource));
  let hex = ""; for (const x of d) hex += x.toString(16).padStart(2, "0");
  return hex;
};
const lineCount = (csv: string): number => (csv.match(/\n/g) ?? []).length;

const expect = (cond: boolean, what: string): void => {
  if (!cond) throw new Error(`assert: ${what}`);
};

// ─── main ────────────────────────────────────────────────────────────────────

const main = async (): Promise<void> => {
  console.log("==> migrate");
  await migrate();

  // build mock manifest + server
  const places = await zstdCompress(PLACES_CSV);
  const postal = await zstdCompress(POSTAL_CSV);
  const countries = await zstdCompress(COUNTRIES_CSV);
  const addrDe = await zstdCompress(ADDR_DE_CSV);
  const addrUs = await zstdCompress(ADDR_US_CSV);

  const manifest = {
    built_at: new Date().toISOString(),
    version: "test-v1",
    license: { geonames: "CC-BY-4.0" },
    files: {
      places: { filename: "places.csv.zst", sha256: await sha256Hex(places), size_bytes: places.byteLength, line_count: lineCount(PLACES_CSV) },
      postal_codes: { filename: "postal_codes.csv.zst", sha256: await sha256Hex(postal), size_bytes: postal.byteLength, line_count: lineCount(POSTAL_CSV) },
      countries: { filename: "countries.csv.zst", sha256: await sha256Hex(countries), size_bytes: countries.byteLength, line_count: lineCount(COUNTRIES_CSV) },
      addresses: [
        { filename: "addresses-de.csv.zst", sha256: await sha256Hex(addrDe), size_bytes: addrDe.byteLength, line_count: lineCount(ADDR_DE_CSV), country_code: "DE" },
        { filename: "addresses-us.csv.zst", sha256: await sha256Hex(addrUs), size_bytes: addrUs.byteLength, line_count: lineCount(ADDR_US_CSV), country_code: "US" },
      ],
    },
    coverage: { DE: "address", US: "address" },
    sources: {
      geonames_cities_url: "https://example.com/cities.zip",
      geonames_postal_url: "https://example.com/postal.zip",
      geonames_country_info_url: "https://example.com/countryInfo.txt",
      openaddresses_url: "https://example.com/oa.zip",
    },
  };

  const files: Record<string, Uint8Array> = {
    "places.csv.zst": places, "postal_codes.csv.zst": postal,
    "countries.csv.zst": countries,
    "addresses-de.csv.zst": addrDe, "addresses-us.csv.zst": addrUs,
  };

  const app = new Hono();
  app.get("/latest.json", (c) => c.json(manifest));
  app.get("/:filename", (c) => {
    const b = files[c.req.param("filename")];
    if (!b) return c.json({ error: "nf" }, 404);
    return new Response(b as BodyInit, { headers: { "Content-Type": "application/zstd" } });
  });
  const server = Bun.serve({ port: PORT, fetch: app.fetch });

  try {
    console.log("==> ingest synthetic data");
    await setupLoader();

    // ─── search: BM25 exact match ─────────────────────────────────────────────
    console.log("==> search 'berlin' (BM25 exact wins)");
    {
      const r = await service.search({
        q: "berlin",
        layers: undefined, country: undefined,
        proximity_lat: undefined, proximity_lng: undefined, bbox: undefined,
        limit: 5,
      });
      if (!r.ok) throw new Error(`search failed: ${r.error.message}`);
      const top = r.data.features[0];
      console.log(`   top: ${top?.layer}/${top?.name} score=${top?.score?.toFixed(3)}`);
      expect(top?.name === "Berlin", `expected top=Berlin, got ${top?.name}`);
      // Berliner Straße should also be in results, ranked lower
      const hasBerliner = r.data.features.some((f) => f.name === "Berliner Straße");
      expect(hasBerliner, "expected Berliner Straße in results");
    }

    // ─── search: trigram fuzzy fallback ───────────────────────────────────────
    console.log("==> search 'munchn' (typo → trgm fallback)");
    {
      const r = await service.search({
        q: "munchn", layers: undefined, country: undefined,
        proximity_lat: undefined, proximity_lng: undefined, bbox: undefined,
        limit: 5,
      });
      if (!r.ok) throw new Error(`search failed: ${r.error.message}`);
      const top = r.data.features[0];
      console.log(`   top: ${top?.name} score=${top?.score?.toFixed(3)}`);
      expect(top?.name === "München", `expected München, got ${top?.name}`);
    }

    // ─── search: layer filter ─────────────────────────────────────────────────
    console.log("==> search 'berlin' layers=address only");
    {
      const r = await service.search({
        q: "berlin", layers: ["address"], country: undefined,
        proximity_lat: undefined, proximity_lng: undefined, bbox: undefined,
        limit: 10,
      });
      if (!r.ok) throw new Error(`search failed: ${r.error.message}`);
      for (const f of r.data.features) {
        expect(f.layer === "address", `non-address layer leaked: ${f.layer}`);
      }
      console.log(`   ${r.data.features.length} address hits, all layer=address ✓`);
    }

    // ─── search: country filter ───────────────────────────────────────────────
    console.log("==> search 'broadway' country=US");
    {
      const r = await service.search({
        q: "broadway", layers: undefined, country: "US",
        proximity_lat: undefined, proximity_lng: undefined, bbox: undefined,
        limit: 5,
      });
      if (!r.ok) throw new Error(`search failed: ${r.error.message}`);
      expect(r.data.features.length > 0, "expected at least one Broadway hit");
      for (const f of r.data.features) {
        expect(f.country_code === "US", `non-US leaked: ${f.country_code}`);
      }
      console.log(`   ${r.data.features.length} hits, all US ✓`);
    }

    // ─── reverse ──────────────────────────────────────────────────────────────
    console.log("==> reverse (52.524, 13.410) — Berlin Mitte");
    {
      const r = await service.reverse({
        lat: 52.524, lng: 13.410, radius: 50, limit: 5,
        layers: undefined,
      });
      if (!r.ok) throw new Error(`reverse failed: ${r.error.message}`);
      const top = r.data.features[0];
      console.log(`   top: ${top?.layer}/${top?.name} ${top?.distance_km?.toFixed(2)}km`);
      expect(top !== undefined, "expected at least one reverse hit");
      expect((top?.distance_km ?? 999) < 1, "expected < 1km");
    }

    // ─── place by gid ─────────────────────────────────────────────────────────
    console.log("==> place by gid");
    {
      const r = await service.place.get("geonames:2950159");
      if (!r.ok) throw new Error(`place.get failed: ${r.error.message}`);
      expect(r.data.place.name === "Berlin", `expected Berlin, got ${r.data.place.name}`);
      const miss = await service.place.get("geonames:does-not-exist");
      expect(!miss.ok && miss.error.status === 404, "expected 404 for missing gid");
    }

    // ─── postal ───────────────────────────────────────────────────────────────
    console.log("==> postal code 10115");
    {
      const r = await service.postal.query({ code: "10115", place: undefined, country: undefined, limit: 10 });
      if (!r.ok) throw new Error(`postal failed: ${r.error.message}`);
      expect(r.data.postal_codes[0]?.place_name === "Berlin Mitte", "expected Berlin Mitte");
    }

    // ─── countries ────────────────────────────────────────────────────────────
    console.log("==> countries list");
    {
      const r = await service.country.list();
      if (!r.ok) throw new Error(`countries failed: ${r.error.message}`);
      expect(r.data.total === 3, `expected 3 countries, got ${r.data.total}`);
      const de = r.data.countries.find((c) => c.code === "DE");
      expect(de !== undefined, "DE missing");
      expect(de!.place_count >= 4, `DE place_count=${de!.place_count}`);
      expect(de!.languages[0] === "de", `DE languages[0]=${de!.languages[0]}`);
    }
    {
      const r = await service.country.get("us");
      if (!r.ok) throw new Error(`country.get failed`);
      expect(r.data.name === "United States", `got ${r.data.name}`);
    }

    // ─── coverage ─────────────────────────────────────────────────────────────
    console.log("==> coverage");
    {
      const r = await service.coverage.get();
      if (!r.ok) throw new Error(`coverage failed`);
      expect(r.data.countries["DE"] === "address", `DE=${r.data.countries["DE"]}`);
      expect(r.data.countries["US"] === "address", `US=${r.data.countries["US"]}`);
      expect(r.data.countries["FR"] === "none", `FR=${r.data.countries["FR"]}`);
      console.log(`   DE=address US=address FR=none ✓`);
    }

    // ─── batch ────────────────────────────────────────────────────────────────
    console.log("==> batch (1 search + 1 reverse)");
    {
      const r = await service.batch.run({
        entries: [
          { type: "search", q: "berlin", layers: undefined, country: undefined, limit: 1 },
          { type: "reverse", lat: 52.524, lng: 13.410, radius: 5, layers: undefined, limit: 1 },
        ],
      });
      if (!r.ok) throw new Error(`batch failed`);
      expect(r.data.results.length === 2, `expected 2 results`);
      expect(r.data.results[0]!.features[0]?.name === "Berlin", "batch[0] not Berlin");
      console.log(`   batch[0]=${r.data.results[0]!.features[0]?.name}, batch[1]=${r.data.results[1]!.features[0]?.name}`);
    }

    console.log("\n✓ Service smoke succeeded");
  } finally {
    stopLoader();
    server.stop(true);
    await sql.end();
  }
};

await main();
process.exit(0);
