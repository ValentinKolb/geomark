import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, copyFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addressesStage } from "../../src/pipeline/04-addresses";
import type { StageCtx } from "../../src/pipeline/runner";

let dir: string;
let stagingDir: string;
let outputDir: string;

const fixturesDir = join(import.meta.dir, "..", "fixtures", "openaddresses");

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "geomark-addresses-"));
  stagingDir = join(dir, "staging");
  outputDir = join(dir, "out");
  await mkdir(join(stagingDir, "extracted", "openaddresses"), { recursive: true });
  await mkdir(outputDir, { recursive: true });

  await copyFile(
    join(fixturesDir, "de.csv"),
    join(stagingDir, "extracted", "openaddresses", "de.csv"),
  );
  await copyFile(
    join(fixturesDir, "us.csv"),
    join(stagingDir, "extracted", "openaddresses", "us.csv"),
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

describe("addressesStage", () => {
  test("produces one addresses-{cc}.csv per input country", async () => {
    await addressesStage.run(makeCtx());

    expect(
      await Bun.file(join(stagingDir, "addresses-de.csv")).exists(),
    ).toBe(true);
    expect(
      await Bun.file(join(stagingDir, "addresses-us.csv")).exists(),
    ).toBe(true);
  });

  test("transforms OA columns to canonical schema and quotes when needed", async () => {
    await addressesStage.run(makeCtx());

    const de = await readFile(join(stagingDir, "addresses-de.csv"), "utf8");
    const lines = de.split("\n").filter(Boolean);

    expect(lines[0]).toBe(
      "gid,latitude,longitude,house_number,street,unit,city,postcode,region,country_code",
    );

    // First German row (Berlin)
    expect(lines[1]).toBe(
      "oa:de:abc1,52.52437,13.41053,12,Müllerstraße,,Berlin,10115,Berlin,DE",
    );

    // Second German row has a comma in the street field — must be quoted
    expect(lines[2]).toBe(
      'oa:de:abc2,52.51000,13.42000,5,"Friedrichstraße, Süd",,Berlin,10117,Berlin,DE',
    );
  });

  test("uses derived gid even without HASH column value", async () => {
    // Build a synthetic CSV with empty HASH values
    const path = join(
      stagingDir,
      "extracted",
      "openaddresses",
      "fr.csv",
    );
    await Bun.write(
      path,
      "HASH,LON,LAT,NUMBER,STREET,UNIT,CITY,DISTRICT,REGION,POSTCODE\n,2.3522,48.8566,1,Rue de Rivoli,,Paris,,IDF,75001\n,2.3000,48.85,99,Rue Blanche,,Paris,,IDF,75009\n",
    );

    await addressesStage.run(makeCtx());
    const fr = await readFile(join(stagingDir, "addresses-fr.csv"), "utf8");
    const lines = fr.split("\n").filter(Boolean);

    // gid falls back to row index 0, 1
    expect(lines[1]).toContain("oa:fr:0,");
    expect(lines[2]).toContain("oa:fr:1,");
  });

  test("writes the addresses.done sentinel", async () => {
    await addressesStage.run(makeCtx());
    expect(await Bun.file(join(stagingDir, "addresses.done")).exists()).toBe(true);
  });

  test("isDone reflects sentinel presence", async () => {
    expect(await addressesStage.isDone(makeCtx())).toBe(false);
    await addressesStage.run(makeCtx());
    expect(await addressesStage.isDone(makeCtx())).toBe(true);
  });

  test("skips countries whose output already exists", async () => {
    // Pre-populate de output, run stage, expect de unchanged
    await Bun.write(
      join(stagingDir, "addresses-de.csv"),
      "preexisting content",
    );
    await addressesStage.run(makeCtx());

    expect(
      await readFile(join(stagingDir, "addresses-de.csv"), "utf8"),
    ).toBe("preexisting content");

    // us was processed normally
    expect(
      await Bun.file(join(stagingDir, "addresses-us.csv")).exists(),
    ).toBe(true);
  });

  test("throws when the OpenAddresses source directory is missing", async () => {
    await rm(join(stagingDir, "extracted", "openaddresses"), { recursive: true });
    await expect(addressesStage.run(makeCtx())).rejects.toThrow(
      /missing or unreadable source directory/,
    );
    expect(await Bun.file(join(stagingDir, "addresses.done")).exists()).toBe(false);
  });

  test("throws when the OpenAddresses source directory is empty", async () => {
    // Wipe the CSV fixtures but keep the dir
    await rm(join(stagingDir, "extracted", "openaddresses", "de.csv"));
    await rm(join(stagingDir, "extracted", "openaddresses", "us.csv"));
    await expect(addressesStage.run(makeCtx())).rejects.toThrow(
      /contains no CSV files/,
    );
    expect(await Bun.file(join(stagingDir, "addresses.done")).exists()).toBe(false);
  });
});
