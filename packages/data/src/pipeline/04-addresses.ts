import { join, basename } from "node:path";
import { readdir } from "node:fs/promises";
import { atomicWriter } from "../lib/atomicWrite";
import { csvRow, parseCsvLine, parseCsvHeader } from "../lib/csv";
import { streamLines } from "../lib/lines";
import type { Stage } from "./runner";

const SENTINEL = "addresses.done";
const SOURCE_DIR = "openaddresses"; // <staging>/extracted/openaddresses/<cc>.csv

const OUTPUT_HEADER = csvRow([
  "gid",
  "latitude",
  "longitude",
  "house_number",
  "street",
  "unit",
  "city",
  "postcode",
  "region",
  "country_code",
]);

/** Columns we read from each OpenAddresses CSV. LON/LAT are required. */
type OaColumns = {
  hash: number | null;
  lon: number;
  lat: number;
  number: number | null;
  street: number | null;
  unit: number | null;
  city: number | null;
  district: number | null;
  region: number | null;
  postcode: number | null;
};

const findOaColumns = (header: Map<string, number>): OaColumns => {
  const required = (name: string): number => {
    const i = header.get(name);
    if (i === undefined) {
      throw new Error(`OpenAddresses CSV missing required column: ${name}`);
    }
    return i;
  };
  const optional = (name: string): number | null => header.get(name) ?? null;
  return {
    hash: optional("HASH"),
    lon: required("LON"),
    lat: required("LAT"),
    number: optional("NUMBER"),
    street: optional("STREET"),
    unit: optional("UNIT"),
    city: optional("CITY"),
    district: optional("DISTRICT"),
    region: optional("REGION"),
    postcode: optional("POSTCODE"),
  };
};

const at = (cols: string[], i: number | null): string | null => {
  if (i === null) return null;
  const v = cols[i];
  return v && v.trim() ? v : null;
};

/**
 * Convert one OpenAddresses CSV (assumed to be a country export, named
 * `<cc>.csv`) into an addresses-{cc}.csv file with our canonical schema.
 * Streams the input so multi-GB country files don't load into memory.
 */
const processCountryFile = async (
  inputPath: string,
  outputPath: string,
  countryCode: string,
): Promise<number> => {
  const writer = atomicWriter(outputPath);
  let rows = 0;
  let header: Map<string, number> | null = null;
  let cols: OaColumns | null = null;

  try {
    await writer.write(OUTPUT_HEADER);
    for await (const line of streamLines(inputPath)) {
      if (!line) continue;
      if (header === null) {
        header = parseCsvHeader(line);
        cols = findOaColumns(header);
        continue;
      }
      const fields = parseCsvLine(line);
      const id = cols!.hash !== null ? at(fields, cols!.hash) : null;
      await writer.write(
        csvRow([
          `oa:${countryCode.toLowerCase()}:${id ?? rows}`,
          fields[cols!.lat] ?? null,
          fields[cols!.lon] ?? null,
          at(fields, cols!.number),
          at(fields, cols!.street),
          at(fields, cols!.unit),
          at(fields, cols!.city),
          at(fields, cols!.postcode),
          at(fields, cols!.region),
          countryCode,
        ]),
      );
      rows++;
    }
    await writer.commit();
  } catch (err) {
    await writer.abort();
    throw err;
  }
  return rows;
};

export const addressesStage: Stage = {
  id: "addresses",
  isDone: async (ctx) =>
    Bun.file(join(ctx.stagingDir, SENTINEL)).exists(),
  run: async (ctx) => {
    const sourceDir = join(ctx.stagingDir, "extracted", SOURCE_DIR);
    let entries: string[];
    try {
      entries = await readdir(sourceDir);
    } catch (err) {
      // Refuse to silently publish a zero-coverage dataset. The OA archive
      // either failed to download/extract or is structured unexpectedly.
      // Surface a clear error rather than write a fake "done" sentinel.
      throw new Error(
        `addresses stage: missing or unreadable source directory ${sourceDir}. ` +
          `Check that the OpenAddresses archive extracted into "openaddresses/<cc>.csv" layout. ` +
          `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const csvs = entries.filter((f) => f.endsWith(".csv")).sort();
    if (csvs.length === 0) {
      throw new Error(
        `addresses stage: ${sourceDir} contains no CSV files. ` +
          `Expected at least one "<cc>.csv" — check the OpenAddresses archive layout.`,
      );
    }
    let totalRows = 0;
    for (const csv of csvs) {
      const cc = basename(csv, ".csv").toUpperCase();
      const inputPath = join(sourceDir, csv);
      const outputPath = join(
        ctx.stagingDir,
        `addresses-${cc.toLowerCase()}.csv`,
      );
      if (await Bun.file(outputPath).exists()) {
        ctx.log(`[addresses] ${cc} already done, skipping`);
        continue;
      }
      const rows = await processCountryFile(inputPath, outputPath, cc);
      ctx.log(`[addresses] ${cc}: ${rows} rows`);
      totalRows += rows;
    }
    await Bun.write(join(ctx.stagingDir, SENTINEL), "");
    ctx.log(`[addresses] total ${totalRows} rows across ${csvs.length} countries`);
  },
};
