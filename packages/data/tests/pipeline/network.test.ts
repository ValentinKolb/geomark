import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, copyFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { buildDataset } from "../../src/pipeline";
import type { Manifest } from "../../src/pipeline/07-publish";

const FIXTURES = join(import.meta.dir, "..", "fixtures");

let dir: string;
let stagingDir: string;
let outputDir: string;
let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;

const zipFromFiles = async (
  zipPath: string,
  files: { name: string; sourcePath: string }[],
): Promise<void> => {
  const tmpDir = `${zipPath}.src`;
  await mkdir(tmpDir, { recursive: true });
  const args: string[] = [];
  for (const { name, sourcePath } of files) {
    const dest = join(tmpDir, name);
    await mkdir(join(dest, ".."), { recursive: true });
    await copyFile(sourcePath, dest);
    args.push(name);
  }
  const proc = Bun.spawn(["zip", "-q", "-r", zipPath, ...args], { cwd: tmpDir });
  if ((await proc.exited) !== 0) throw new Error("zip failed");
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "geomark-network-"));
  stagingDir = join(dir, "staging");
  outputDir = join(dir, "out");
  await mkdir(stagingDir, { recursive: true });
  await mkdir(outputDir, { recursive: true });

  // Build the synthetic source archives the mock server will serve
  const citiesZip = join(dir, "cities.zip");
  const postalZip = join(dir, "postal.zip");
  const oaZip = join(dir, "oa.zip");
  await zipFromFiles(citiesZip, [
    {
      name: "cities-test.txt",
      sourcePath: join(FIXTURES, "geonames", "cities-sample.txt"),
    },
  ]);
  await zipFromFiles(postalZip, [
    {
      name: "allCountries.txt",
      sourcePath: join(FIXTURES, "geonames", "postal-sample.txt"),
    },
  ]);
  await zipFromFiles(oaZip, [
    {
      name: "openaddresses/de.csv",
      sourcePath: join(FIXTURES, "openaddresses", "de.csv"),
    },
    {
      name: "openaddresses/us.csv",
      sourcePath: join(FIXTURES, "openaddresses", "us.csv"),
    },
  ]);
  const countryInfo = join(dir, "countryInfo.txt");
  await copyFile(
    join(FIXTURES, "geonames", "countryInfo-sample.txt"),
    countryInfo,
  );

  // Local HTTP server that mimics every upstream the pipeline talks to
  const app = new Hono();
  app.get("/cities-test.zip", () => new Response(Bun.file(citiesZip).stream(), {
    headers: { "Content-Type": "application/zip" },
  }));
  app.get("/postal-test.zip", () => new Response(Bun.file(postalZip).stream(), {
    headers: { "Content-Type": "application/zip" },
  }));
  app.get("/countryInfo.txt", () => new Response(Bun.file(countryInfo).stream(), {
    headers: { "Content-Type": "text/plain" },
  }));
  app.get("/oa-test.zip", () => new Response(Bun.file(oaZip).stream(), {
    headers: { "Content-Type": "application/zip" },
  }));
  server = Bun.serve({ port: 0, fetch: app.fetch });
  baseUrl = `http://localhost:${server.port}`;
});

afterEach(async () => {
  server.stop(true);
  await rm(dir, { recursive: true, force: true });
});

describe("pipeline network integration (all sources mocked locally)", () => {
  test("downloads → extracts → builds dataset → writes manifest", async () => {
    await buildDataset(
      {
        geonamesCitiesUrl: `${baseUrl}/cities-test.zip`,
        geonamesPostalUrl: `${baseUrl}/postal-test.zip`,
        geonamesCountryInfoUrl: `${baseUrl}/countryInfo.txt`,
        openaddressesUrl: `${baseUrl}/oa-test.zip`,
        citiesFilename: "cities-test.txt",
        postalFilename: "postal-test.txt",
      },
      { stagingDir, outputDir, log: () => {} },
    );

    // Output files
    expect(await Bun.file(join(outputDir, "places.csv.zst")).exists()).toBe(true);
    expect(await Bun.file(join(outputDir, "postal_codes.csv.zst")).exists()).toBe(true);
    expect(await Bun.file(join(outputDir, "countries.csv.zst")).exists()).toBe(true);
    expect(await Bun.file(join(outputDir, "addresses-de.csv.zst")).exists()).toBe(true);
    expect(await Bun.file(join(outputDir, "addresses-us.csv.zst")).exists()).toBe(true);
    expect(await Bun.file(join(outputDir, "latest.json")).exists()).toBe(true);

    // Manifest
    const manifest = JSON.parse(
      await readFile(join(outputDir, "latest.json"), "utf8"),
    ) as Manifest;
    expect(manifest.coverage).toEqual({ DE: "address", US: "address" });
    expect(manifest.files.places.line_count).toBe(6); // 5 fixture cities + header
    expect(manifest.files.postal_codes.line_count).toBe(6);
    expect(manifest.files.countries.line_count).toBe(4);
    expect(manifest.files.addresses).toHaveLength(2);
  });

  test("re-running against the same sources keeps file SHA-256s stable", async () => {
    const cfg = {
      geonamesCitiesUrl: `${baseUrl}/cities-test.zip`,
      geonamesPostalUrl: `${baseUrl}/postal-test.zip`,
      geonamesCountryInfoUrl: `${baseUrl}/countryInfo.txt`,
      openaddressesUrl: `${baseUrl}/oa-test.zip`,
      citiesFilename: "cities-test.txt",
        postalFilename: "postal-test.txt",
    };
    const ctx = { stagingDir, outputDir, log: () => {} };

    await buildDataset(cfg, ctx);
    const first = JSON.parse(
      await readFile(join(outputDir, "latest.json"), "utf8"),
    ) as Manifest;

    await buildDataset(cfg, ctx);
    const second = JSON.parse(
      await readFile(join(outputDir, "latest.json"), "utf8"),
    ) as Manifest;

    expect(second.files.places.sha256).toBe(first.files.places.sha256);
    expect(second.files.postal_codes.sha256).toBe(first.files.postal_codes.sha256);
  });
});
