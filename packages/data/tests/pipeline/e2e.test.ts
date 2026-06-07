import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, copyFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStages } from "../../src/pipeline/runner";
import { placesStage } from "../../src/pipeline/03-places";
import { addressesStage } from "../../src/pipeline/04-addresses";
import { postalStage } from "../../src/pipeline/05-postal";
import { countriesStage } from "../../src/pipeline/06-countries";
import { publishStage, type Manifest } from "../../src/pipeline/07-publish";

const FIXTURES = join(import.meta.dir, "..", "fixtures");

const SOURCES = {
  geonames_cities_url: "https://example/cities500.zip",
  geonames_postal_url: "https://example/allCountries.zip",
  geonames_country_info_url: "https://example/countryInfo.txt",
  openaddresses_url: "https://example/openaddresses.zip",
};

let dir: string;
let stagingDir: string;
let outputDir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "geomark-e2e-"));
  stagingDir = join(dir, "staging");
  outputDir = join(dir, "out");
  await mkdir(join(stagingDir, "extracted", "openaddresses"), { recursive: true });
  await mkdir(outputDir, { recursive: true });

  // Pre-populate as if download+extract had succeeded
  await Bun.write(join(stagingDir, "extracted", ".done"), "");
  await copyFile(
    join(FIXTURES, "geonames", "cities-sample.txt"),
    join(stagingDir, "extracted", "cities500.txt"),
  );
  await copyFile(
    join(FIXTURES, "geonames", "postal-sample.txt"),
    join(stagingDir, "extracted", "allCountries.txt"),
  );
  await copyFile(
    join(FIXTURES, "geonames", "countryInfo-sample.txt"),
    join(stagingDir, "extracted", "countryInfo.txt"),
  );
  await copyFile(
    join(FIXTURES, "openaddresses", "de.csv"),
    join(stagingDir, "extracted", "openaddresses", "de.csv"),
  );
  await copyFile(
    join(FIXTURES, "openaddresses", "us.csv"),
    join(stagingDir, "extracted", "openaddresses", "us.csv"),
  );
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("pipeline end-to-end (post-extract)", () => {
  test("stages 03..07 produce a complete dataset and manifest", async () => {
    await runStages(
      [
        placesStage("cities500.txt"),
        addressesStage,
        postalStage,
        countriesStage,
        publishStage(SOURCES),
        
      ],
      { stagingDir, outputDir, log: () => {} },
    );

    // All compressed outputs exist
    expect(await Bun.file(join(outputDir, "places.csv.zst")).exists()).toBe(true);
    expect(
      await Bun.file(join(outputDir, "postal_codes.csv.zst")).exists(),
    ).toBe(true);
    expect(await Bun.file(join(outputDir, "countries.csv.zst")).exists()).toBe(
      true,
    );
    expect(
      await Bun.file(join(outputDir, "addresses-de.csv.zst")).exists(),
    ).toBe(true);
    expect(
      await Bun.file(join(outputDir, "addresses-us.csv.zst")).exists(),
    ).toBe(true);
    expect(await Bun.file(join(outputDir, "latest.json")).exists()).toBe(true);

    // Manifest content
    const manifest = JSON.parse(
      await readFile(join(outputDir, "latest.json"), "utf8"),
    ) as Manifest;

    expect(manifest.sources).toEqual(SOURCES);
    expect(manifest.coverage).toEqual({ DE: "address", US: "address" });

    // line_count counts every newline in the compressed file, including
    // the CSV header — so each file reports `data_rows + 1`.
    expect(manifest.files.places.line_count).toBe(6); // 5 cities + header
    expect(manifest.files.postal_codes.line_count).toBe(6); // 5 entries + header
    expect(manifest.files.countries.line_count).toBe(4); // DE/US/FR + header

    expect(manifest.files.addresses).toHaveLength(2);
    const de = manifest.files.addresses.find((a) => a.country_code === "DE");
    const us = manifest.files.addresses.find((a) => a.country_code === "US");
    expect(de?.line_count).toBe(4); // 3 addresses + header
    expect(us?.line_count).toBe(3); // 2 addresses + header
  });

  test("re-running the pipeline produces a stable dataset (same hashes)", async () => {
    const ctx = { stagingDir, outputDir, log: () => {} };
    const stages = [
      placesStage("cities500.txt"),
      addressesStage,
      postalStage,
      countriesStage,
      publishStage(SOURCES),
      
    ];

    await runStages(stages, ctx);
    const first = JSON.parse(
      await readFile(join(outputDir, "latest.json"), "utf8"),
    ) as Manifest;

    await runStages(stages, ctx);
    const second = JSON.parse(
      await readFile(join(outputDir, "latest.json"), "utf8"),
    ) as Manifest;

    // built_at differs by design (manifest always re-runs), but the data
    // identity (per-file SHA-256) must not drift on a no-op refresh.
    expect(second.files.places.sha256).toBe(first.files.places.sha256);
    expect(second.files.postal_codes.sha256).toBe(first.files.postal_codes.sha256);
    expect(second.files.countries.sha256).toBe(first.files.countries.sha256);
    expect(second.files.addresses.map((a) => a.sha256).sort()).toEqual(
      first.files.addresses.map((a) => a.sha256).sort(),
    );
  });
});
