import { basename, join, relative } from "node:path";
import { readdir } from "node:fs/promises";
import { atomicWriter } from "../lib/atomicWrite";
import { csvRow, parseCsvLine, parseCsvHeader } from "../lib/csv";
import { streamLines } from "../lib/lines";
import type { Stage } from "./runner";

const SENTINEL = "addresses.done";
const PREPARED_SOURCE_DIR = "openaddresses"; // <staging>/extracted/openaddresses/<cc>.csv

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

type AddressSource = {
  kind: "csv" | "geojson";
  path: string;
  relativePath: string;
  countryCode: string;
};

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

const text = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s.length > 0 ? s : null;
};

const prop = (
  props: Record<string, unknown> | undefined,
  ...names: string[]
): string | null => {
  if (!props) return null;
  for (const name of names) {
    const direct = text(props[name]);
    if (direct !== null) return direct;
    const upper = text(props[name.toUpperCase()]);
    if (upper !== null) return upper;
  }
  return null;
};

const countryFromFirstSegment = (relativePath: string): string | null => {
  const first = relativePath.split(/[\\/]/).find(Boolean);
  return first && /^[a-z]{2}$/i.test(first) ? first.toUpperCase() : null;
};

const walkFiles = async (dir: string): Promise<string[]> => {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const out: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walkFiles(path)));
    } else if (entry.isFile()) {
      out.push(path);
    }
  }
  return out;
};

const isAddressGeoJson = (relativePath: string): boolean => {
  const lower = relativePath.toLowerCase();
  if (!lower.endsWith(".geojson")) return false;
  const file = basename(lower, ".geojson");
  return /(^|[-_])addresses?([-_]|$)/.test(file);
};

const sourceSort = (a: AddressSource, b: AddressSource): number =>
  a.countryCode.localeCompare(b.countryCode) ||
  a.relativePath.localeCompare(b.relativePath);

export const detectOpenAddressesSources = async (
  extractedDir: string,
): Promise<AddressSource[]> => {
  const preparedDir = join(extractedDir, PREPARED_SOURCE_DIR);
  const preparedFiles = (await walkFiles(preparedDir))
    .filter((path) => path.toLowerCase().endsWith(".csv"))
    .map((path) => {
      const countryCode = basename(path, ".csv").toUpperCase();
      if (!/^[A-Z]{2}$/.test(countryCode)) return null;
      const source: AddressSource = {
        kind: "csv",
        path,
        relativePath: relative(extractedDir, path),
        countryCode,
      };
      return source;
    })
    .filter((v): v is AddressSource => v !== null)
    .sort(sourceSort);
  if (preparedFiles.length > 0) return preparedFiles;

  const allFiles = await walkFiles(extractedDir);

  const legacyCsv = allFiles
    .filter((path) => path.toLowerCase().endsWith(".csv"))
    .map((path) => {
      const relativePath = relative(extractedDir, path);
      if (relativePath.toLowerCase().startsWith("summary/")) return null;
      const countryCode = countryFromFirstSegment(relativePath);
      if (!countryCode) return null;
      const source: AddressSource = {
        kind: "csv",
        path,
        relativePath,
        countryCode,
      };
      return source;
    })
    .filter((v): v is AddressSource => v !== null)
    .sort(sourceSort);
  if (legacyCsv.length > 0) return legacyCsv;

  return allFiles
    .map((path) => {
      const relativePath = relative(extractedDir, path);
      const countryCode = countryFromFirstSegment(relativePath);
      if (!countryCode || !isAddressGeoJson(relativePath)) return null;
      const source: AddressSource = {
        kind: "geojson",
        path,
        relativePath,
        countryCode,
      };
      return source;
    })
    .filter((v): v is AddressSource => v !== null)
    .sort(sourceSort);
};

const writeCsvRows = async (
  writer: ReturnType<typeof atomicWriter>,
  source: AddressSource,
  rowIndex: number,
): Promise<number> => {
  let header: Map<string, number> | null = null;
  let cols: OaColumns | null = null;

  for await (const line of streamLines(source.path)) {
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
        `oa:${source.countryCode.toLowerCase()}:${id ?? rowIndex}`,
        fields[cols!.lat] ?? null,
        fields[cols!.lon] ?? null,
        at(fields, cols!.number),
        at(fields, cols!.street),
        at(fields, cols!.unit),
        at(fields, cols!.city),
        at(fields, cols!.postcode),
        at(fields, cols!.region),
        source.countryCode,
      ]),
    );
    rowIndex++;
  }
  return rowIndex;
};

type GeoJsonFeature = {
  type?: string;
  properties?: Record<string, unknown>;
  geometry?: {
    type?: string;
    coordinates?: unknown;
  };
};

type GeoJsonFeatureCollection = {
  type?: string;
  features?: GeoJsonFeature[];
};

const pointCoordinates = (
  feature: GeoJsonFeature,
): { lon: string; lat: string } | null => {
  const geom = feature.geometry;
  if (!geom || geom.type !== "Point" || !Array.isArray(geom.coordinates)) {
    return null;
  }
  const lon = Number(geom.coordinates[0]);
  const lat = Number(geom.coordinates[1]);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  return { lon: String(lon), lat: String(lat) };
};

const writeGeoJsonFeature = async (
  writer: ReturnType<typeof atomicWriter>,
  source: AddressSource,
  feature: GeoJsonFeature,
  rowIndex: number,
): Promise<number> => {
  if (feature.type !== "Feature") return rowIndex;
  const coords = pointCoordinates(feature);
  if (!coords) return rowIndex;

  const props = feature.properties;
  const id = prop(props, "hash", "id");
  await writer.write(
    csvRow([
      `oa:${source.countryCode.toLowerCase()}:${id ?? rowIndex}`,
      coords.lat,
      coords.lon,
      prop(props, "number", "house_number", "housenumber"),
      prop(props, "street"),
      prop(props, "unit"),
      prop(props, "city"),
      prop(props, "postcode", "postal_code", "zip"),
      prop(props, "region", "district"),
      source.countryCode,
    ]),
  );
  return rowIndex + 1;
};

const writeGeoJsonRows = async (
  writer: ReturnType<typeof atomicWriter>,
  source: AddressSource,
  rowIndex: number,
): Promise<number> => {
  let lineNumber = 0;
  for await (const line of streamLines(source.path)) {
    lineNumber++;
    if (!line.trim()) continue;
    let parsed: GeoJsonFeature | GeoJsonFeatureCollection;
    try {
      parsed = JSON.parse(line) as typeof parsed;
    } catch (err) {
      throw new Error(
        `invalid GeoJSON in ${source.relativePath}:${lineNumber}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }

    if (
      parsed.type === "FeatureCollection" &&
      Array.isArray((parsed as GeoJsonFeatureCollection).features)
    ) {
      for (const feature of (parsed as GeoJsonFeatureCollection).features!) {
        rowIndex = await writeGeoJsonFeature(writer, source, feature, rowIndex);
      }
    } else {
      rowIndex = await writeGeoJsonFeature(
        writer,
        source,
        parsed as GeoJsonFeature,
        rowIndex,
      );
    }
  }
  return rowIndex;
};

const writeCountryOutput = async (
  sources: AddressSource[],
  outputPath: string,
  countryCode: string,
): Promise<number> => {
  const writer = atomicWriter(outputPath);
  let rowIndex = 0;
  try {
    await writer.write(OUTPUT_HEADER);
    for (const source of sources) {
      rowIndex = source.kind === "csv"
        ? await writeCsvRows(writer, source, rowIndex)
        : await writeGeoJsonRows(writer, source, rowIndex);
    }
    await writer.commit();
    return rowIndex;
  } catch (err) {
    await writer.abort();
    throw err;
  }
};

export const addressesStage: Stage = {
  id: "addresses",
  isDone: async (ctx) =>
    Bun.file(join(ctx.stagingDir, SENTINEL)).exists(),
  run: async (ctx) => {
    const extractedDir = join(ctx.stagingDir, "extracted");
    const sources = await detectOpenAddressesSources(extractedDir);
    if (sources.length === 0) {
      throw new Error(
        `addresses stage: no supported OpenAddresses inputs under ${extractedDir}. ` +
          `Expected prepared CSVs in "openaddresses/<cc>.csv", legacy CSVs under "<cc>/...", ` +
          `or Batch address GeoJSON files under "<cc>/.../*addresses*.geojson".`,
      );
    }

    const byCountry = new Map<string, AddressSource[]>();
    for (const source of sources) {
      const arr = byCountry.get(source.countryCode) ?? [];
      arr.push(source);
      byCountry.set(source.countryCode, arr);
    }

    let totalRows = 0;
    const countries = [...byCountry.keys()].sort();
    for (const countryCode of countries) {
      const outputPath = join(
        ctx.stagingDir,
        `addresses-${countryCode.toLowerCase()}.csv`,
      );
      if (await Bun.file(outputPath).exists()) {
        ctx.log(`[addresses] ${countryCode} already done, skipping`);
        continue;
      }
      const rows = await writeCountryOutput(
        byCountry.get(countryCode)!,
        outputPath,
        countryCode,
      );
      totalRows += rows;
      ctx.log(
        `[addresses] ${countryCode}: ${rows} rows from ${byCountry.get(countryCode)!.length} source file(s)`,
      );
    }

    await Bun.write(join(ctx.stagingDir, SENTINEL), "");
    ctx.log(`[addresses] total ${totalRows} rows across ${countries.length} countries`);
  },
};
