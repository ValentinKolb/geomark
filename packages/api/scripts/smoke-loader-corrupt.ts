#!/usr/bin/env bun
/**
 * Smoke test: SHA-mismatch path rejects ingest WITHOUT touching DB.
 * Loads a good dataset first, then advertises a manifest with the wrong
 * SHA for places. Asserts the new ingest throws AND the previous places
 * data is still intact (atomic verify-before-truncate).
 */
import { sql } from "bun";
import { Hono } from "hono";
import { migrate } from "../src/migrate";
import { ingestAll } from "../src/loader/ingest";
import { fetchManifest } from "../src/loader/manifest";

const PORT = 19998;

const PLACES_CSV =
  "geonameid,name,asciiname,latitude,longitude,feature_class,feature_code,country_code,admin1_code,admin2_code,population,elevation,timezone\n" +
  "1,A,A,0,0,P,PPL,DE,01,,1,0,UTC\n";
const POSTAL_CSV =
  "country_code,postal_code,place_name,admin_name1,admin_code1,latitude,longitude\n" +
  "DE,1,A,X,01,0,0\n";
const COUNTRIES_CSV =
  "code,code3,name,capital,continent,currency_code,languages,calling_code,flag_emoji\n" +
  "DE,DEU,Germany,Berlin,EU,EUR,de,49,🇩🇪\n";

const zstdCompress = async (data: string): Promise<Uint8Array> => {
  const proc = Bun.spawn(["zstd", "-q"], { stdin: "pipe", stdout: "pipe" });
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

const main = async (): Promise<void> => {
  console.log("==> migrating");
  await migrate();

  const places = await zstdCompress(PLACES_CSV);
  const postal = await zstdCompress(POSTAL_CSV);
  const countries = await zstdCompress(COUNTRIES_CSV);
  const placesSha = await sha256Hex(places);
  const postalSha = await sha256Hex(postal);
  const countriesSha = await sha256Hex(countries);

  let advertisedPlacesSha = placesSha;
  const app = new Hono();
  app.get("/latest.json", (c) =>
    c.json({
      built_at: new Date().toISOString(),
      version: "v1",
      license: { geonames: "CC-BY-4.0" },
      files: {
        places: { filename: "places.csv.zst", sha256: advertisedPlacesSha, size_bytes: places.byteLength, line_count: 2 },
        postal_codes: { filename: "postal_codes.csv.zst", sha256: postalSha, size_bytes: postal.byteLength, line_count: 2 },
        countries: { filename: "countries.csv.zst", sha256: countriesSha, size_bytes: countries.byteLength, line_count: 2 },
        addresses: [],
      },
      coverage: {},
      sources: {
        geonames_cities_url: "https://example.com/cities.zip",
        geonames_postal_url: "https://example.com/postal.zip",
        geonames_country_info_url: "https://example.com/countryInfo.txt",
        openaddresses_url: "https://example.com/oa.zip",
      },
    }),
  );
  const files: Record<string, Uint8Array> = {
    "places.csv.zst": places,
    "postal_codes.csv.zst": postal,
    "countries.csv.zst": countries,
  };
  app.get("/:filename", (c) => {
    const b = files[c.req.param("filename")];
    if (!b) return c.json({ error: "nf" }, 404);
    return new Response(b as BodyInit, { headers: { "Content-Type": "application/zstd" } });
  });
  const server = Bun.serve({ port: PORT, fetch: app.fetch });
  const baseUrl = `http://localhost:${PORT}`;

  try {
    console.log("==> first ingest with correct SHAs");
    const m1 = await fetchManifest(baseUrl);
    await ingestAll(baseUrl, m1, "fp-1");
    const [c1] = await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM geomark.places`;
    if (c1?.n !== 1) throw new Error(`expected 1 place, got ${c1?.n}`);
    console.log("   places=1 ✓");

    console.log("==> second ingest with TAMPERED places SHA — must throw + leave DB intact");
    advertisedPlacesSha = "0".repeat(64);
    const m2 = await fetchManifest(baseUrl);
    let threw = false;
    try {
      await ingestAll(baseUrl, m2, "fp-2");
    } catch (err) {
      threw = true;
      const msg = String(err);
      if (!msg.includes("sha256 mismatch")) throw new Error(`wrong error: ${msg}`);
      console.log(`   threw expected error: ${msg.split('\n')[0]}`);
    }
    if (!threw) throw new Error("ingestAll did not throw on SHA mismatch");

    const [c2] = await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM geomark.places`;
    if (c2?.n !== 1) throw new Error(`places was wiped! got ${c2?.n}`);
    console.log(`   places still has ${c2.n} row (atomic verify-before-truncate ✓)`);

    console.log("\n✓ Corruption-rejection smoke succeeded");
  } finally {
    server.stop(true);
    await sql.end();
  }
};

await main();
process.exit(0);
