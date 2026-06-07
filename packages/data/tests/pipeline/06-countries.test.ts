import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, copyFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countriesStage } from "../../src/pipeline/06-countries";
import type { StageCtx } from "../../src/pipeline/runner";

let dir: string;
let stagingDir: string;
let outputDir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "geomark-countries-"));
  stagingDir = join(dir, "staging");
  outputDir = join(dir, "out");
  await mkdir(join(stagingDir, "extracted"), { recursive: true });
  await mkdir(outputDir, { recursive: true });

  await copyFile(
    join(import.meta.dir, "..", "fixtures", "geonames", "countryInfo-sample.txt"),
    join(stagingDir, "extracted", "countryInfo.txt"),
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

describe("countriesStage", () => {
  test("parses countryInfo into a flat CSV with flag emoji", async () => {
    await countriesStage.run(makeCtx());

    const csv = await readFile(join(stagingDir, "countries.csv"), "utf8");
    const lines = csv.split("\n").filter(Boolean);

    expect(lines).toHaveLength(4); // header + 3 rows
    expect(lines[0]).toBe(
      "code,code3,name,capital,continent,currency_code,languages,calling_code,flag_emoji",
    );

    expect(lines[1]).toBe("DE,DEU,Germany,Berlin,EU,EUR,de;en,49,🇩🇪");
    expect(lines[2]).toBe(
      "US,USA,United States,Washington,NA,USD,en-US;es-US;haw;fr,1,🇺🇸",
    );
    expect(lines[3]).toBe(
      "FR,FRA,France,Paris,EU,EUR,fr-FR;frp;br;co;ca;eu;oc,33,🇫🇷",
    );
  });

  test("skips comment header lines", async () => {
    // The fixture has 3 comment lines + 3 data lines.
    await countriesStage.run(makeCtx());
    const csv = await readFile(join(stagingDir, "countries.csv"), "utf8");
    expect(csv.split("\n").filter(Boolean)).toHaveLength(4); // header + 3 data rows
  });

  test("isDone reflects output presence", async () => {
    expect(await countriesStage.isDone(makeCtx())).toBe(false);
    await countriesStage.run(makeCtx());
    expect(await countriesStage.isDone(makeCtx())).toBe(true);
  });
});
