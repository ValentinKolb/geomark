import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, copyFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addressesStage,
  detectOpenAddressesSources,
} from "../../src/pipeline/04-addresses";
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

  test("detects and ingests OpenAddresses Batch NDJSON GeoJSON address files", async () => {
    await rm(join(stagingDir, "extracted", "openaddresses"), { recursive: true });
    await mkdir(join(stagingDir, "extracted", "us", "pa"), { recursive: true });
    await Bun.write(
      join(stagingDir, "extracted", "us", "pa", "wyoming-addresses-county.geojson"),
      [
        JSON.stringify({
          type: "Feature",
          properties: {
            hash: "batch-1",
            number: "44",
            street: "Market St",
            unit: "2B",
            city: "Tunkhannock",
            postcode: "18657",
            region: "PA",
            district: "Wyoming",
          },
          geometry: { type: "Point", coordinates: [-75.946, 41.538] },
        }),
        JSON.stringify({
          type: "Feature",
          properties: {
            id: "batch-2",
            number: 10,
            street: "Main, North",
            city: "Meshoppen",
            postcode: "18630",
            region: "PA",
          },
          geometry: { type: "Point", coordinates: [-76.047, 41.614] },
        }),
        "",
      ].join("\n"),
    );
    await Bun.write(
      join(stagingDir, "extracted", "us", "pa", "wyoming-addresses-county.geojson.meta"),
      "{}",
    );
    await Bun.write(
      join(stagingDir, "extracted", "us", "pa", "wyoming-parcels-county.geojson"),
      JSON.stringify({
        type: "Feature",
        properties: { hash: "parcel-ignored", street: "Parcel Rd" },
        geometry: { type: "Point", coordinates: [-1, 1] },
      }),
    );

    const sources = await detectOpenAddressesSources(
      join(stagingDir, "extracted"),
    );
    expect(sources.map((s) => s.relativePath)).toEqual([
      "us/pa/wyoming-addresses-county.geojson",
    ]);

    await addressesStage.run(makeCtx());
    const us = await readFile(join(stagingDir, "addresses-us.csv"), "utf8");
    const lines = us.split("\n").filter(Boolean);

    expect(lines[0]).toBe(
      "gid,latitude,longitude,house_number,street,unit,city,postcode,region,country_code",
    );
    expect(lines[1]).toBe(
      "oa:us:batch-1,41.538,-75.946,44,Market St,2B,Tunkhannock,18657,PA,US",
    );
    expect(lines[2]).toBe(
      'oa:us:batch-2,41.614,-76.047,10,"Main, North",,Meshoppen,18630,PA,US',
    );
    expect(us).not.toContain("parcel-ignored");
  });

  test("groups legacy global CSV layout by country", async () => {
    await rm(join(stagingDir, "extracted", "openaddresses"), { recursive: true });
    await mkdir(join(stagingDir, "extracted", "us", "tx"), { recursive: true });
    await mkdir(join(stagingDir, "extracted", "us", "pa"), { recursive: true });
    await mkdir(join(stagingDir, "extracted", "summary"), { recursive: true });
    await Bun.write(
      join(stagingDir, "extracted", "us", "tx", "yoakum.csv"),
      "HASH,LON,LAT,NUMBER,STREET,UNIT,CITY,DISTRICT,REGION,POSTCODE\nlegacy1,-102,33,1,Main St,,Plains,,TX,79355\n",
    );
    await Bun.write(
      join(stagingDir, "extracted", "us", "pa", "erie.csv"),
      "HASH,LON,LAT,NUMBER,STREET,UNIT,CITY,DISTRICT,REGION,POSTCODE\nlegacy2,-80,42,2,Lake Rd,,Erie,,PA,16501\n",
    );
    await Bun.write(
      join(stagingDir, "extracted", "summary", "ignored.csv"),
      "HASH,LON,LAT,NUMBER,STREET,UNIT,CITY,DISTRICT,REGION,POSTCODE\nbad,0,0,0,Bad,,,,,\n",
    );

    await addressesStage.run(makeCtx());
    const us = await readFile(join(stagingDir, "addresses-us.csv"), "utf8");

    expect(us).toContain("oa:us:legacy2,42,-80,2,Lake Rd,,Erie,16501,PA,US");
    expect(us).toContain("oa:us:legacy1,33,-102,1,Main St,,Plains,79355,TX,US");
    expect(us).not.toContain("Bad");
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
      /no supported OpenAddresses inputs/,
    );
    expect(await Bun.file(join(stagingDir, "addresses.done")).exists()).toBe(false);
  });

  test("throws when the OpenAddresses source directory is empty", async () => {
    // Wipe the CSV fixtures but keep the dir
    await rm(join(stagingDir, "extracted", "openaddresses", "de.csv"));
    await rm(join(stagingDir, "extracted", "openaddresses", "us.csv"));
    await expect(addressesStage.run(makeCtx())).rejects.toThrow(
      /no supported OpenAddresses inputs/,
    );
    expect(await Bun.file(join(stagingDir, "addresses.done")).exists()).toBe(false);
  });
});
