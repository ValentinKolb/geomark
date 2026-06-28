import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, copyFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { postalStage } from "../../src/pipeline/05-postal";
import type { StageCtx } from "../../src/pipeline/runner";

let dir: string;
let stagingDir: string;
let outputDir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "geomark-postal-"));
  stagingDir = join(dir, "staging");
  outputDir = join(dir, "out");
  await mkdir(join(stagingDir, "extracted"), { recursive: true });
  await mkdir(outputDir, { recursive: true });

  // Copy the fixture into the expected extracted location
  await copyFile(
    join(import.meta.dir, "..", "fixtures", "geonames", "postal-sample.txt"),
    join(stagingDir, "extracted", "allCountries.txt"),
  );
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const makeCtx = (): StageCtx => ({
  stagingDir,
  outputDir,
  log: () => {},
});

const stage = () => postalStage("allCountries.txt");

describe("postalStage", () => {
  test("parses GeoNames TSV into clean CSV", async () => {
    await stage().run(makeCtx());

    const csv = await readFile(join(stagingDir, "postal_codes.csv"), "utf8");
    const lines = csv.split("\n").filter(Boolean);

    // header + 5 data rows
    expect(lines).toHaveLength(6);
    expect(lines[0]).toBe(
      "country_code,postal_code,place_name,admin_name1,admin_code1,latitude,longitude",
    );

    // Berlin row
    expect(lines[1]).toBe("DE,10115,Berlin,Berlin,BE,52.5311,13.3856");

    // Place name with comma must be quoted
    expect(lines[3]).toBe(
      'US,10001,"New York, NY",New York,NY,40.7484,-73.9967',
    );

    // Postal code with internal space (UK) passes through
    expect(lines[4]).toBe(
      "GB,SW1A 1AA,London,England,ENG,51.501,-0.1416",
    );
  });

  test("isDone is true when output exists", async () => {
    await stage().run(makeCtx());
    expect(await stage().isDone(makeCtx())).toBe(true);
  });

  test("isDone is false when output is missing", async () => {
    expect(await stage().isDone(makeCtx())).toBe(false);
  });
});
