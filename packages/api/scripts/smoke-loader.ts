#!/usr/bin/env bun
/**
 * Smoke test for the API loader.
 *
 * Spins up a tiny HTTP server that mimics @geomark/data's static
 * file output (manifest + .csv.zst files), runs the loader against
 * it, and asserts the DB has the expected rows.
 *
 * Requires DATABASE_URL pointing to a fresh timescale/timescaledb-ha
 * (with PostGIS, pg_trgm, pg_textsearch, unaccent).
 *
 *   docker run -d --rm --name pg -e POSTGRES_PASSWORD=test \
 *     -e POSTGRES_USER=test -e POSTGRES_DB=test -p 54390:5432 \
 *     timescale/timescaledb-ha:pg17-all
 *
 *   DATABASE_URL=postgres://test:test@localhost:54390/test \
 *     DATA_URL=http://localhost:19999 \
 *     bun packages/api/scripts/smoke-loader.ts
 */
import { sql } from "bun";
import { Hono } from "hono";
import { migrate } from "../src/migrate";
import { setupLoader, stopLoader } from "../src/loader";

const PORT = 19999;

// ─── synthetic data ──────────────────────────────────────────────────────────

const PLACES_CSV = [
  "geonameid,name,asciiname,latitude,longitude,feature_class,feature_code,country_code,admin1_code,admin2_code,population,elevation,timezone",
  "2950159,Berlin,Berlin,52.52437,13.41053,P,PPLC,DE,16,00,3645000,34,Europe/Berlin",
  "2867714,München,Muenchen,48.13743,11.57549,P,PPLA,DE,02,,1471000,520,Europe/Berlin",
  "5128581,New York City,New York City,40.71427,-74.00597,P,PPL,US,NY,061,8175133,10,America/New_York",
  "5391959,San Francisco,San Francisco,37.77493,-122.41942,P,PPLA2,US,CA,075,864816,16,America/Los_Angeles",
].join("\n") + "\n";

const POSTAL_CSV = [
  "country_code,postal_code,place_name,admin_name1,admin_code1,latitude,longitude",
  "DE,10115,Berlin Mitte,Berlin,16,52.5326,13.3850",
  "DE,80331,München Altstadt,Bayern,02,48.1374,11.5755",
  "US,10004,New York,New York,NY,40.6993,-74.0156",
  "US,94115,San Francisco,California,CA,37.7858,-122.4378",
].join("\n") + "\n";

const COUNTRIES_CSV = [
  "code,code3,name,capital,continent,currency_code,languages,calling_code,flag_emoji",
  "DE,DEU,Germany,Berlin,EU,EUR,de,49,🇩🇪",
  "US,USA,United States,Washington,NA,USD,en-US;es-US;haw,1,🇺🇸",
].join("\n") + "\n";

const ADDR_DE_CSV = [
  "gid,latitude,longitude,house_number,street,unit,city,postcode,region,country_code",
  "oa:de:abc1,52.52437,13.41053,12,Müllerstraße,,Berlin,10115,Berlin,DE",
  "oa:de:abc2,52.51000,13.42000,5,Friedrichstraße,,Berlin,10117,Berlin,DE",
  "oa:de:abc3,48.13700,11.57500,7a,Marienplatz,,München,80331,Bayern,DE",
].join("\n") + "\n";

const ADDR_US_CSV = [
  "gid,latitude,longitude,house_number,street,unit,city,postcode,region,country_code",
  "oa:us:001,40.71427,-74.00597,1,Broadway,,New York,10004,NY,US",
  "oa:us:002,37.77493,-122.41942,2300,Fillmore St,Apt 3,San Francisco,94115,CA,US",
].join("\n") + "\n";

// ─── compression + hashing ───────────────────────────────────────────────────

const zstdCompress = async (data: string): Promise<Uint8Array> => {
  const proc = Bun.spawn(["zstd", "-q"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(new TextEncoder().encode(data));
  await proc.stdin.end();
  const out = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
  if ((await proc.exited) !== 0) throw new Error("zstd compress failed");
  return out;
};

const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const d = new Uint8Array(
    await crypto.subtle.digest("SHA-256", bytes as BufferSource),
  );
  let hex = "";
  for (const b of d) hex += b.toString(16).padStart(2, "0");
  return hex;
};

const lineCount = (csv: string): number =>
  (csv.match(/\n/g) ?? []).length;

// ─── mock server ─────────────────────────────────────────────────────────────

type Artifact = { bytes: Uint8Array; sha: string; lines: number };

const makeArtifact = async (csv: string): Promise<Artifact> => {
  const bytes = await zstdCompress(csv);
  return {
    bytes,
    sha: await sha256Hex(bytes),
    lines: lineCount(csv),
  };
};

const startMockServer = async () => {
  const places = await makeArtifact(PLACES_CSV);
  const postal = await makeArtifact(POSTAL_CSV);
  const countries = await makeArtifact(COUNTRIES_CSV);
  const addrDe = await makeArtifact(ADDR_DE_CSV);
  const addrUs = await makeArtifact(ADDR_US_CSV);

  const manifest = {
    built_at: new Date().toISOString(),
    version: "2026-04-27",
    license: { geonames: "CC-BY-4.0", openaddresses: "various" },
    files: {
      places: {
        filename: "places.csv.zst",
        sha256: places.sha,
        size_bytes: places.bytes.byteLength,
        line_count: places.lines,
      },
      postal_codes: {
        filename: "postal_codes.csv.zst",
        sha256: postal.sha,
        size_bytes: postal.bytes.byteLength,
        line_count: postal.lines,
      },
      countries: {
        filename: "countries.csv.zst",
        sha256: countries.sha,
        size_bytes: countries.bytes.byteLength,
        line_count: countries.lines,
      },
      addresses: [
        {
          filename: "addresses-de.csv.zst",
          sha256: addrDe.sha,
          size_bytes: addrDe.bytes.byteLength,
          line_count: addrDe.lines,
          country_code: "DE",
        },
        {
          filename: "addresses-us.csv.zst",
          sha256: addrUs.sha,
          size_bytes: addrUs.bytes.byteLength,
          line_count: addrUs.lines,
          country_code: "US",
        },
      ],
    },
    coverage: { DE: "address", US: "address" },
    sources: {
      geonames_cities_url: "https://example.com/cities.zip",
      geonames_postal_url: "https://example.com/allCountries.zip",
      geonames_country_info_url: "https://example.com/countryInfo.txt",
      openaddresses_url: "https://example.com/oa.zip",
    },
  };

  const files: Record<string, Uint8Array> = {
    "places.csv.zst": places.bytes,
    "postal_codes.csv.zst": postal.bytes,
    "countries.csv.zst": countries.bytes,
    "addresses-de.csv.zst": addrDe.bytes,
    "addresses-us.csv.zst": addrUs.bytes,
  };

  const app = new Hono();
  app.get("/latest.json", (c) => c.json(manifest));
  app.get("/:filename", (c) => {
    const name = c.req.param("filename");
    const bytes = files[name];
    if (!bytes) return c.json({ error: "not found" }, 404);
    return new Response(bytes as BodyInit, {
      headers: { "Content-Type": "application/zstd" },
    });
  });

  const server = Bun.serve({ port: PORT, fetch: app.fetch });
  return { stop: () => server.stop(true), manifest };
};

// ─── main ────────────────────────────────────────────────────────────────────

const expect = <T>(actual: T, expected: T, what: string): void => {
  if (actual !== expected) {
    throw new Error(`${what}: expected ${expected}, got ${actual}`);
  }
};

const main = async (): Promise<void> => {
  console.log("==> running migrations");
  await migrate();

  console.log(`==> starting mock data server on :${PORT}`);
  const mock = await startMockServer();

  try {
    console.log("==> running setupLoader (initial refresh)");
    await setupLoader();

    console.log("==> verifying row counts");
    const [counts] = await sql<
      { places: number; addresses: number; postal: number; countries: number }[]
    >`
      SELECT
        (SELECT COUNT(*)::int FROM geomark.places) AS places,
        (SELECT COUNT(*)::int FROM geomark.addresses) AS addresses,
        (SELECT COUNT(*)::int FROM geomark.postal_codes) AS postal,
        (SELECT COUNT(*)::int FROM geomark.countries) AS countries
    `;
    if (!counts) throw new Error("no counts row");
    expect(counts.places, 4, "places count");
    expect(counts.addresses, 5, "addresses count");
    expect(counts.postal, 4, "postal count");
    expect(counts.countries, 2, "countries count");
    console.log(
      `   places:${counts.places} addresses:${counts.addresses} postal:${counts.postal} countries:${counts.countries}`,
    );

    console.log("==> verifying meta");
    const [meta] = await sql<
      { dataset_version: string | null; loaded_at: Date | null }[]
    >`SELECT dataset_version, loaded_at FROM geomark.meta WHERE id = TRUE`;
    if (meta?.dataset_version !== "2026-04-27") {
      throw new Error(`meta.dataset_version: ${meta?.dataset_version}`);
    }
    if (!meta.loaded_at) throw new Error("meta.loaded_at missing");
    console.log(`   version=${meta.dataset_version} at=${meta.loaded_at.toISOString()}`);

    console.log("==> verifying generated columns (geom + search_text)");
    const [berlin] = await sql<
      { name: string; search_text: string; geom_wkt: string }[]
    >`
      SELECT name, search_text, ST_AsText(geom) AS geom_wkt
      FROM geomark.places WHERE gid = 'geonames:2950159'
    `;
    if (!berlin) throw new Error("Berlin row missing");
    expect(berlin.search_text, "berlin", "berlin.search_text");
    if (!berlin.geom_wkt.startsWith("POINT(13.41053 52.52437)")) {
      throw new Error(`berlin.geom_wkt: ${berlin.geom_wkt}`);
    }

    console.log("==> verifying address label compose");
    const [addr] = await sql<{ label: string; search_text: string }[]>`
      SELECT label, search_text FROM geomark.addresses
      WHERE gid = 'oa:de:abc1'
    `;
    if (!addr) throw new Error("Address oa:de:abc1 missing");
    if (!addr.label.includes("12 Müllerstraße")) {
      throw new Error(`address label: ${addr.label}`);
    }
    if (!addr.search_text.includes("mullerstrasse")) {
      throw new Error(`address search_text: ${addr.search_text}`);
    }
    console.log(`   label="${addr.label}" search_text="${addr.search_text}"`);

    console.log("==> verifying second refresh is a no-op");
    const t0 = Date.now();
    const { setupLoader: again } = await import("../src/loader");
    await again();
    const elapsed = Date.now() - t0;
    if (elapsed > 2000) {
      console.warn(`  WARN: second refresh took ${elapsed}ms (expected <2s for no-op)`);
    } else {
      console.log(`   second refresh: ${elapsed}ms`);
    }

    console.log("\n✓ Loader smoke succeeded");
  } finally {
    stopLoader();
    mock.stop();
    await sql.end();
  }
};

await main();
process.exit(0);
