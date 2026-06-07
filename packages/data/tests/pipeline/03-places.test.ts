import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, copyFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { placesStage } from "../../src/pipeline/03-places";
import type { StageCtx } from "../../src/pipeline/runner";

let dir: string;
let stagingDir: string;
let outputDir: string;
const stage = placesStage("cities500.txt");

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "geomark-places-"));
  stagingDir = join(dir, "staging");
  outputDir = join(dir, "out");
  await mkdir(join(stagingDir, "extracted"), { recursive: true });
  await mkdir(outputDir, { recursive: true });

  await copyFile(
    join(import.meta.dir, "..", "fixtures", "geonames", "cities-sample.txt"),
    join(stagingDir, "extracted", "cities500.txt"),
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

describe("placesStage", () => {
  test("parses GeoNames cities into places.csv with selected columns", async () => {
    await stage.run(makeCtx());
    const csv = await readFile(join(stagingDir, "places.csv"), "utf8");
    const lines = csv.split("\n").filter(Boolean);

    expect(lines).toHaveLength(6); // header + 5 cities
    expect(lines[0]).toBe(
      "geonameid,name,asciiname,latitude,longitude,feature_class,feature_code,country_code,admin1_code,admin2_code,population,elevation,timezone",
    );

    expect(lines[1]).toBe(
      "2950159,Berlin,Berlin,52.52437,13.41053,P,PPLC,DE,16,00,3426354,74,Europe/Berlin",
    );

    // Tokyo has no admin2_code in fixture — empty CSV column
    expect(lines[5]).toBe(
      "1850147,Tokyo,Tokyo,35.6895,139.69171,P,PPLC,JP,40,,13929286,44,Asia/Tokyo",
    );
  });

  test("skips rows with non-numeric geonameid", async () => {
    // Append a malformed line
    const path = join(stagingDir, "extracted", "cities500.txt");
    const original = await readFile(path, "utf8");
    await Bun.write(
      path,
      original + "garbage\tbad\tline\twith\ttoo\tfew\tcols\n",
    );

    await stage.run(makeCtx());
    const csv = await readFile(join(stagingDir, "places.csv"), "utf8");
    expect(csv.split("\n").filter(Boolean)).toHaveLength(6); // unchanged
  });

  test("isDone reflects output presence", async () => {
    expect(await stage.isDone(makeCtx())).toBe(false);
    await stage.run(makeCtx());
    expect(await stage.isDone(makeCtx())).toBe(true);
  });
});
