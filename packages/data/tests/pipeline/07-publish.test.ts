import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decompressFile } from "../../src/lib/zstd";
import { publishStage, type Manifest } from "../../src/pipeline/07-publish";
import type { StageCtx } from "../../src/pipeline/runner";

const SOURCES = {
  geonames_cities_url: "https://example/cities.zip",
  geonames_postal_url: "https://example/postal.zip",
  geonames_country_info_url: "https://example/countryInfo.txt",
  openaddresses_url: "https://example/oa.zip",
};

let dir: string;
let stagingDir: string;
let outputDir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "geomark-publish-"));
  stagingDir = join(dir, "staging");
  outputDir = join(dir, "out");
  await mkdir(stagingDir, { recursive: true });
  await mkdir(outputDir, { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const makeCtx = (): StageCtx => ({
  stagingDir,
  outputDir,
  log: () => {},
});

const writeStaging = (filename: string, content: string): Promise<number> =>
  Bun.write(join(stagingDir, filename), content);

describe("publishStage — compression", () => {
  test("compresses every staging .csv to <output>/<name>.csv.zst", async () => {
    await writeStaging("places.csv", "id,name\n1,Berlin\n");
    await writeStaging("postal_codes.csv", "id\n1\n");
    await writeStaging("countries.csv", "code\nDE\n");
    await writeStaging("addresses-de.csv", "id\n1\n");

    await publishStage(SOURCES).run(makeCtx());

    expect(await Bun.file(join(outputDir, "places.csv.zst")).exists()).toBe(true);
    expect(
      await Bun.file(join(outputDir, "addresses-de.csv.zst")).exists(),
    ).toBe(true);
  });

  test("round-trip: compressed output decompresses to original CSV", async () => {
    const original = "code,name\nDE,Germany\nFR,France\n";
    await writeStaging("places.csv", "id\n1\n");
    await writeStaging("postal_codes.csv", "id\n1\n");
    await writeStaging("countries.csv", original);

    await publishStage(SOURCES).run(makeCtx());

    const restored = join(dir, "restored.csv");
    await decompressFile(join(outputDir, "countries.csv.zst"), restored);
    expect(await readFile(restored, "utf8")).toBe(original);
  });

  test("recompresses on every run (refreshes propagate updated CSVs)", async () => {
    await writeStaging("places.csv", "id\n1\n");
    await writeStaging("postal_codes.csv", "id\n1\n");
    await writeStaging("countries.csv", "first\n");

    await publishStage(SOURCES).run(makeCtx());

    await writeStaging("countries.csv", "second\n");
    await publishStage(SOURCES).run(makeCtx());

    const restored = join(dir, "restored.csv");
    await decompressFile(join(outputDir, "countries.csv.zst"), restored);
    expect(await readFile(restored, "utf8")).toBe("second\n");
  });

  test("prunes stale .csv.zst outputs whose source no longer exists", async () => {
    await writeStaging("places.csv", "id\n1\n");
    await writeStaging("postal_codes.csv", "id\n1\n");
    await writeStaging("countries.csv", "id\n1\n");
    await writeStaging("addresses-de.csv", "id\n1\n");
    await writeStaging("addresses-us.csv", "id\n1\n");
    await publishStage(SOURCES).run(makeCtx());

    expect(
      await Bun.file(join(outputDir, "addresses-us.csv.zst")).exists(),
    ).toBe(true);

    // Refresh: US no longer in OpenAddresses → staging only has DE addresses
    await rm(join(stagingDir, "addresses-us.csv"));
    await publishStage(SOURCES).run(makeCtx());

    expect(
      await Bun.file(join(outputDir, "addresses-us.csv.zst")).exists(),
    ).toBe(false);
    expect(
      await Bun.file(join(outputDir, "addresses-de.csv.zst")).exists(),
    ).toBe(true);
  });

  test("ignores non-csv files in staging", async () => {
    await writeStaging("places.csv", "id\n1\n");
    await writeStaging("postal_codes.csv", "id\n1\n");
    await writeStaging("countries.csv", "id\n1\n");
    await Bun.write(join(stagingDir, "notes.txt"), "not a csv");
    await Bun.write(join(stagingDir, "raw.zip"), "not a csv");

    await publishStage(SOURCES).run(makeCtx());

    expect(await Bun.file(join(outputDir, "notes.txt.zst")).exists()).toBe(false);
    expect(await Bun.file(join(outputDir, "raw.zip.zst")).exists()).toBe(false);
  });

  test("throws when staging contains no CSV at all", async () => {
    await expect(publishStage(SOURCES).run(makeCtx())).rejects.toThrow(
      /no CSV files/,
    );
  });
});

describe("publishStage — manifest", () => {
  test("writes latest.json with sha256, size, line_count, sources, coverage", async () => {
    await writeStaging("places.csv", "id\n1\n2\n3\n");
    await writeStaging("postal_codes.csv", "p\nq\n");
    await writeStaging("countries.csv", "DE\nFR\nUS\n");
    await writeStaging("addresses-de.csv", "1\n2\n");
    await writeStaging("addresses-us.csv", "1\n");

    await publishStage(SOURCES).run(makeCtx());

    const manifest = JSON.parse(
      await readFile(join(outputDir, "latest.json"), "utf8"),
    ) as Manifest;

    expect(manifest.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(manifest.built_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(manifest.sources).toEqual(SOURCES);
    expect(manifest.license).toMatchObject({ geonames: "CC-BY-4.0" });

    expect(manifest.files.places.line_count).toBe(4);
    expect(manifest.files.places.filename).toBe("places.csv.zst");
    expect(manifest.files.places.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.files.places.size_bytes).toBeGreaterThan(0);

    expect(manifest.files.postal_codes.line_count).toBe(2);
    expect(manifest.files.countries.line_count).toBe(3);

    expect(manifest.files.addresses).toHaveLength(2);
    expect(manifest.files.addresses[0]?.country_code).toBe("DE");
    expect(manifest.files.addresses[0]?.line_count).toBe(2);
    expect(manifest.files.addresses[1]?.country_code).toBe("US");
    expect(manifest.files.addresses[1]?.line_count).toBe(1);

    expect(manifest.coverage).toEqual({ DE: "address", US: "address" });
  });

  test("ignores files that don't match addresses-{cc}.csv.zst", async () => {
    await writeStaging("places.csv", "x\n");
    await writeStaging("postal_codes.csv", "x\n");
    await writeStaging("countries.csv", "x\n");
    await writeStaging("addresses-de.csv", "x\n");
    await publishStage(SOURCES).run(makeCtx());

    // Decoy files in output that look like address chunks but aren't valid
    await Bun.write(join(outputDir, "addresses.csv.zst"), "x"); // missing -cc
    await Bun.write(join(outputDir, "addresses-deu.csv.zst"), "x"); // 3-letter

    // Re-publish — but we have to keep staging matching to trigger a successful run
    await publishStage(SOURCES).run(makeCtx());

    const manifest = JSON.parse(
      await readFile(join(outputDir, "latest.json"), "utf8"),
    ) as Manifest;
    // The publish stage's pruning step removes the decoys (they're .csv.zst
    // without a matching staging source), so the manifest sees only DE.
    expect(manifest.files.addresses).toHaveLength(1);
    expect(manifest.files.addresses[0]?.country_code).toBe("DE");
  });

  test("isDone is always false — manifest must reflect current output", async () => {
    expect(await publishStage(SOURCES).isDone(makeCtx())).toBe(false);
  });
});

describe("publishStage — large-file regression (Bug #3)", () => {
  test("running the stage 5 times yields a deterministic line_count", async () => {
    // Big enough to span multiple stream chunks; this is what tripped
    // the original Promise.all race in the manifest stage.
    const lines = ["id,name", ...Array.from({ length: 30_000 }, (_, i) => `${i},n${i}`)];
    await writeStaging("places.csv", lines.join("\n") + "\n");
    await writeStaging("postal_codes.csv", "x\n");
    await writeStaging("countries.csv", "x\n");

    const counts: number[] = [];
    for (let i = 0; i < 5; i++) {
      await rm(join(outputDir, "latest.json"), { force: true });
      await publishStage(SOURCES).run(makeCtx());
      const m = JSON.parse(
        await readFile(join(outputDir, "latest.json"), "utf8"),
      ) as Manifest;
      counts.push(m.files.places.line_count);
    }
    expect(new Set(counts).size).toBe(1);
    expect(counts[0]).toBe(30_001);
  });
});
