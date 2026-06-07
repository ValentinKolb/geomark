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
  geonames_cities_url: "https://example/c.zip",
  geonames_postal_url: "https://example/p.zip",
  geonames_country_info_url: "https://example/countryInfo.txt",
  openaddresses_url: "https://example/oa/oa.zip",
};

let dir: string;
let stagingDir: string;
let outputDir: string;

const setupExtractedState = async (): Promise<void> => {
  await mkdir(join(stagingDir, "extracted", "openaddresses"), { recursive: true });
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
};

const allStages = () => [
  placesStage("cities500.txt"),
  addressesStage,
  postalStage,
  countriesStage,
  publishStage(SOURCES),
];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "geomark-resume-"));
  stagingDir = join(dir, "staging");
  outputDir = join(dir, "out");
  await mkdir(stagingDir, { recursive: true });
  await mkdir(outputDir, { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ctx = () => ({ stagingDir, outputDir, log: () => {} });

describe("pipeline resume after crash", () => {
  test("a stale .tmp file from a previous crash is overwritten cleanly", async () => {
    await setupExtractedState();

    // Simulate a crash mid-write: places.csv.tmp left behind with garbage
    await Bun.write(
      join(stagingDir, "places.csv.tmp"),
      "GARBAGE FROM PREVIOUS RUN",
    );

    await runStages(allStages(), ctx());

    // Final places.csv exists with correct header
    const places = await readFile(join(stagingDir, "places.csv"), "utf8");
    expect(places.startsWith("geonameid,name,asciiname")).toBe(true);
    // .tmp is gone
    expect(await Bun.file(join(stagingDir, "places.csv.tmp")).exists()).toBe(false);
    // Final manifest contains the correct count
    const manifest = JSON.parse(
      await readFile(join(outputDir, "latest.json"), "utf8"),
    ) as Manifest;
    expect(manifest.files.places.line_count).toBe(6);
  });

  test("partial /data — missing manifest only — re-runs publish", async () => {
    await setupExtractedState();
    await runStages(allStages(), ctx());

    // Simulate: scheduler/operator deleted just the manifest
    await rm(join(outputDir, "latest.json"));

    // Track which stages run by spying on log
    const ran: string[] = [];
    await runStages(allStages(), {
      ...ctx(),
      log: (msg) => {
        const m = msg.match(/^\[(.+?)\] (start|skip)/);
        if (m && m[2] === "start") ran.push(m[1]!);
      },
    });

    // publish always re-runs (so refreshes can propagate); the
    // upstream parsing stages skipped because their staging outputs exist.
    expect(ran).toEqual(["publish"]);
    expect(await Bun.file(join(outputDir, "latest.json")).exists()).toBe(true);
  });

  test("partial /data — one address chunk missing — publish re-runs", async () => {
    await setupExtractedState();
    await runStages(allStages(), ctx());

    // Simulate corrupt/missing per-country chunk
    await rm(join(outputDir, "addresses-de.csv.zst"));
    await rm(join(outputDir, "latest.json"));

    const ran: string[] = [];
    await runStages(allStages(), {
      ...ctx(),
      log: (msg) => {
        const m = msg.match(/^\[(.+?)\] (start|skip)/);
        if (m && m[2] === "start") ran.push(m[1]!);
      },
    });

    // publish re-emits the missing chunk; upstream parsers skip
    expect(ran).toEqual(["publish"]);
    expect(
      await Bun.file(join(outputDir, "addresses-de.csv.zst")).exists(),
    ).toBe(true);
  });

  test("partial staging — places.csv missing but downstream done — re-runs places + publish", async () => {
    await setupExtractedState();
    await runStages(allStages(), ctx());

    // Simulate: someone wiped places.csv from staging but kept the rest
    await rm(join(stagingDir, "places.csv"));
    await rm(join(outputDir, "places.csv.zst"));
    await rm(join(outputDir, "latest.json"));

    const ran: string[] = [];
    await runStages(allStages(), {
      ...ctx(),
      log: (msg) => {
        const m = msg.match(/^\[(.+?)\] (start|skip)/);
        if (m && m[2] === "start") ran.push(m[1]!);
      },
    });

    expect(ran).toEqual(["places", "publish"]);
  });
});
