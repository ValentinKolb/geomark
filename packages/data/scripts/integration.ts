#!/usr/bin/env bun
/**
 * Real-world end-to-end integration run.
 *
 * Hits the network for GeoNames sources (cities15000 + allCountries postal +
 * countryInfo), and uses a tiny synthetic OpenAddresses zip served from a
 * local HTTP server because OA's public distribution requires AWS-signed
 * batch URLs that aren't trivial to embed here.
 *
 * Usage: bun run packages/data/scripts/integration.ts
 *        (run from the monorepo root)
 */
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { buildDataset } from "../src/pipeline";
import type { Manifest } from "../src/pipeline/07-publish";

const GEONAMES_CITIES = "https://download.geonames.org/export/dump/cities15000.zip";
const GEONAMES_POSTAL = "https://download.geonames.org/export/zip/allCountries.zip";
const GEONAMES_COUNTRY_INFO = "https://download.geonames.org/export/dump/countryInfo.txt";

const buildOaZip = async (zipPath: string): Promise<void> => {
  const stagingDir = `${zipPath}.src`;
  const oaSubdir = join(stagingDir, "openaddresses");
  await mkdir(oaSubdir, { recursive: true });

  await Bun.write(
    join(oaSubdir, "de.csv"),
    "HASH,LON,LAT,NUMBER,STREET,UNIT,CITY,DISTRICT,REGION,POSTCODE\n" +
      "abc1,13.41053,52.52437,12,Müllerstraße,,Berlin,Mitte,Berlin,10115\n" +
      "abc2,13.42000,52.51000,5,Friedrichstraße,,Berlin,Mitte,Berlin,10117\n" +
      "abc3,11.57500,48.13700,7a,Marienplatz,,München,,Bayern,80331\n",
  );
  await Bun.write(
    join(oaSubdir, "us.csv"),
    "HASH,LON,LAT,NUMBER,STREET,UNIT,CITY,DISTRICT,REGION,POSTCODE\n" +
      "us001,-74.00597,40.71427,1,Broadway,,New York,,NY,10004\n" +
      "us002,-122.41942,37.77493,2300,Fillmore St,Apt 3,San Francisco,,CA,94115\n",
  );

  // zip -r preserves the openaddresses/ folder structure inside the archive
  const proc = Bun.spawn(
    ["zip", "-q", "-r", zipPath, "openaddresses"],
    { cwd: stagingDir, stderr: "pipe" },
  );
  if ((await proc.exited) !== 0) {
    throw new Error(`zip failed: ${await new Response(proc.stderr).text()}`);
  }
};

const startMockOaServer = async (zipPath: string): Promise<{ url: string; stop: () => void }> => {
  const app = new Hono();
  app.get("/openaddresses-mock.zip", async (c) => {
    const file = Bun.file(zipPath);
    return new Response(file.stream(), {
      headers: { "Content-Type": "application/zip" },
    });
  });

  const server = Bun.serve({ port: 0, fetch: app.fetch });
  return {
    url: `http://localhost:${server.port}/openaddresses-mock.zip`,
    stop: () => server.stop(true),
  };
};

const main = async (): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), "geomark-integration-"));
  const stagingDir = join(dir, "staging");
  const outputDir = join(dir, "out");
  await mkdir(stagingDir, { recursive: true });
  await mkdir(outputDir, { recursive: true });

  const oaZip = join(dir, "oa-mock.zip");
  await buildOaZip(oaZip);
  const mockServer = await startMockOaServer(oaZip);

  console.log("=".repeat(60));
  console.log("Geomark data builder — real-world integration run");
  console.log("=".repeat(60));
  console.log(`staging: ${stagingDir}`);
  console.log(`output:  ${outputDir}`);
  console.log(`mock OA server: ${mockServer.url}`);
  console.log("");

  const t0 = Date.now();
  try {
    await buildDataset(
      {
        geonamesCitiesUrl: GEONAMES_CITIES,
        geonamesPostalUrl: GEONAMES_POSTAL,
        geonamesCountryInfoUrl: GEONAMES_COUNTRY_INFO,
        openaddressesUrl: mockServer.url,
        citiesFilename: "cities15000.txt",
        postalFilename: "allCountries.txt",
      },
      {
        stagingDir,
        outputDir,
        log: (msg) => console.log(msg),
      },
    );
  } finally {
    mockServer.stop();
  }
  const elapsedSeconds = ((Date.now() - t0) / 1000).toFixed(1);

  console.log("");
  console.log(`Pipeline finished in ${elapsedSeconds}s. Inspecting output…`);
  console.log("");

  const manifestText = await readFile(join(outputDir, "latest.json"), "utf8");
  const manifest = JSON.parse(manifestText) as Manifest;

  console.log(`Manifest version:  ${manifest.version}`);
  console.log(`Built at:          ${manifest.built_at}`);
  console.log("");
  console.log("File summary:");
  console.log(`  places:        ${manifest.files.places.line_count.toLocaleString()} rows, ${(manifest.files.places.size_bytes / 1024).toFixed(1)} KB`);
  console.log(`  postal_codes:  ${manifest.files.postal_codes.line_count.toLocaleString()} rows, ${(manifest.files.postal_codes.size_bytes / 1024 / 1024).toFixed(1)} MB`);
  console.log(`  countries:     ${manifest.files.countries.line_count.toLocaleString()} rows, ${(manifest.files.countries.size_bytes / 1024).toFixed(1)} KB`);
  for (const a of manifest.files.addresses) {
    console.log(`  addresses-${a.country_code}:   ${a.line_count.toLocaleString()} rows, ${(a.size_bytes / 1024).toFixed(1)} KB`);
  }
  console.log("");
  console.log(`Coverage:  ${Object.keys(manifest.coverage).length} countries with address-level (${Object.keys(manifest.coverage).join(", ")})`);
  console.log("");
  console.log("✓ Integration run succeeded");
  console.log(`(temp dir at ${dir}, manually delete if desired)`);
};

await main();
