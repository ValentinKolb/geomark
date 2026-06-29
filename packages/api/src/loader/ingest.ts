import { mkdtemp, unlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql, type SQL } from "bun";
import { toPgTextArray } from "../db";
import { parseCsvLine, parseCsvHeader } from "../lib/csv";
import { streamLines, sha256OfFile } from "../lib/streams";
import type { Manifest, AddressFileEntry } from "./manifest";

/**
 * Conservative batch size: Postgres' extended-query protocol caps a single
 * statement at 65 535 parameters. With our widest table (places: 13 cols),
 * 4 000 × 13 = 52 000 stays well below the limit and leaves headroom for
 * small column additions.
 */
const BATCH_SIZE = 4_000;
const FETCH_TIMEOUT_MS = 5 * 60 * 1000; // 5 min per file

// ─── small helpers ───────────────────────────────────────────────────────────

const orNull = (s: string | undefined | null): string | null =>
  s !== undefined && s !== null && s.length > 0 ? s : null;

const numOrNull = (s: string | undefined | null): number | null => {
  if (s === undefined || s === null || s.length === 0) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

const numOrThrow = (s: string | undefined, what: string, ctx: string): number => {
  const n = numOrNull(s);
  if (n === null) {
    throw new Error(`${ctx}: ${what}: expected number, got ${JSON.stringify(s)}`);
  }
  return n;
};

const buildLabel = (parts: {
  house_number: string | null;
  street: string | null;
  city: string | null;
  postcode: string | null;
  region: string | null;
  country_code: string | null;
}): string => {
  const street = [parts.house_number, parts.street].filter(Boolean).join(" ");
  const where = [parts.postcode, parts.city].filter(Boolean).join(" ");
  return [street, where, parts.region, parts.country_code]
    .filter((s) => s && s.length > 0)
    .join(", ");
};

const requireHeaders = (
  header: Map<string, number>,
  required: readonly string[],
  filename: string,
): void => {
  const missing = required.filter((h) => !header.has(h));
  if (missing.length > 0) {
    throw new Error(
      `${filename}: missing required CSV header(s): ${missing.join(", ")}`,
    );
  }
};

// ─── fetch to temp file + SHA-256 verify ─────────────────────────────────────

/**
 * Stream a response body to a file on disk without holding the whole
 * thing in memory. (Bun's `Bun.write(path, response)` hangs on some
 * server response shapes — manual reader+writer avoids that.)
 */
const fetchToFile = async (
  url: string,
  destPath: string,
): Promise<void> => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    if (!resp.ok) {
      throw new Error(`fetch ${url}: ${resp.status} ${resp.statusText}`);
    }
    if (!resp.body) {
      throw new Error(`fetch ${url}: empty body`);
    }
    const writer = Bun.file(destPath).writer();
    const reader = resp.body.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        writer.write(value);
      }
    } finally {
      await writer.end();
      reader.releaseLock();
    }
  } finally {
    clearTimeout(timer);
  }
};

const fetchAndVerifyToFile = async (
  url: string,
  expectedSha: string,
  tempDir: string,
  shortName: string,
): Promise<string> => {
  const path = join(tempDir, shortName);
  await fetchToFile(url, path);
  const actual = await sha256OfFile(path);
  if (actual !== expectedSha) {
    throw new Error(
      `sha256 mismatch for ${url}: expected ${expectedSha}, got ${actual}`,
    );
  }
  return path;
};

// ─── streaming CSV from a compressed file on disk ────────────────────────────

type RowMapper<TRow> = (
  cols: string[],
  header: Map<string, number>,
  ctx: { filename: string; lineNo: number },
) => TRow;

/**
 * Spawn `zstd -dcq <path>` (no stdin pipe → no deadlock risk) and yield
 * batches of mapped rows. The subprocess is always reaped — kill+await on
 * early exit so we never leak a zombie.
 */
async function* streamCsvBatches<TRow>(
  path: string,
  filename: string,
  required: readonly string[],
  mapRow: RowMapper<TRow>,
): AsyncGenerator<TRow[]> {
  const proc = Bun.spawn(["zstd", "-dcq", path], {
    stdout: "pipe",
    stderr: "pipe",
  });
  let header: Map<string, number> | null = null;
  let batch: TRow[] = [];
  let lineNo = 0;
  try {
    for await (const line of streamLines(proc.stdout)) {
      lineNo++;
      if (line.length === 0) continue;
      if (header === null) {
        header = parseCsvHeader(line);
        requireHeaders(header, required, filename);
        continue;
      }
      const cols = parseCsvLine(line);
      batch.push(mapRow(cols, header, { filename, lineNo }));
      if (batch.length >= BATCH_SIZE) {
        yield batch;
        batch = [];
      }
    }
    if (batch.length > 0) yield batch;

    const exit = await proc.exited;
    if (exit !== 0) {
      const errText = await new Response(proc.stderr).text();
      throw new Error(`zstd ${filename}: exit ${exit}: ${errText}`);
    }
  } finally {
    // If the loop exited via throw, kill the subprocess so it doesn't linger.
    if (proc.exitCode === null) {
      proc.kill();
      await proc.exited.catch(() => {});
    }
  }
}

// ─── per-table mappers ───────────────────────────────────────────────────────
// Object keys MUST match DB column names — Bun's `sql(rows)` derives the
// column list from keys. Generated columns (geom, search_text) MUST NOT
// appear here; Postgres rejects writes to them.

type PlaceRow = {
  gid: string;
  name: string;
  asciiname: string | null;
  latitude: number;
  longitude: number;
  feature_class: string | null;
  feature_code: string | null;
  country_code: string | null;
  admin1_code: string | null;
  admin2_code: string | null;
  population: number | null;
  elevation: number | null;
  timezone: string | null;
};

const PLACES_REQUIRED = [
  "GEONAMEID", "NAME", "LATITUDE", "LONGITUDE",
] as const;

const mapPlace: RowMapper<PlaceRow> = (cols, h, ctx) => {
  const at = (k: string): string | undefined => cols[h.get(k)!];
  const where = `${ctx.filename}:${ctx.lineNo}`;
  return {
    gid: `geonames:${at("GEONAMEID")}`,
    name: at("NAME") ?? "",
    asciiname: orNull(at("ASCIINAME")),
    latitude: numOrThrow(at("LATITUDE"), "latitude", where),
    longitude: numOrThrow(at("LONGITUDE"), "longitude", where),
    feature_class: orNull(at("FEATURE_CLASS")),
    feature_code: orNull(at("FEATURE_CODE")),
    country_code: orNull(at("COUNTRY_CODE")),
    admin1_code: orNull(at("ADMIN1_CODE")),
    admin2_code: orNull(at("ADMIN2_CODE")),
    population: numOrNull(at("POPULATION")),
    elevation: numOrNull(at("ELEVATION")),
    timezone: orNull(at("TIMEZONE")),
  };
};

type AddressRow = {
  gid: string;
  latitude: number;
  longitude: number;
  house_number: string | null;
  street: string | null;
  unit: string | null;
  city: string | null;
  postcode: string | null;
  region: string | null;
  country_code: string | null;
  label: string;
};

const ADDRESSES_REQUIRED = [
  "GID", "LATITUDE", "LONGITUDE",
] as const;

const mapAddress: RowMapper<AddressRow> = (cols, h, ctx) => {
  const at = (k: string): string | undefined => cols[h.get(k)!];
  const where = `${ctx.filename}:${ctx.lineNo}`;
  const r = {
    gid: at("GID") ?? "",
    latitude: numOrThrow(at("LATITUDE"), "latitude", where),
    longitude: numOrThrow(at("LONGITUDE"), "longitude", where),
    house_number: orNull(at("HOUSE_NUMBER")),
    street: orNull(at("STREET")),
    unit: orNull(at("UNIT")),
    city: orNull(at("CITY")),
    postcode: orNull(at("POSTCODE")),
    region: orNull(at("REGION")),
    country_code: orNull(at("COUNTRY_CODE")),
  };
  return { ...r, label: buildLabel(r) };
};

type PostalRow = {
  country_code: string;
  postal_code: string;
  place_name: string | null;
  admin_name1: string | null;
  admin_code1: string | null;
  latitude: number | null;
  longitude: number | null;
};

const POSTAL_REQUIRED = ["COUNTRY_CODE", "POSTAL_CODE"] as const;

const mapPostal: RowMapper<PostalRow> = (cols, h) => {
  const at = (k: string): string | undefined => cols[h.get(k)!];
  return {
    country_code: at("COUNTRY_CODE") ?? "",
    postal_code: at("POSTAL_CODE") ?? "",
    place_name: orNull(at("PLACE_NAME")),
    admin_name1: orNull(at("ADMIN_NAME1")),
    admin_code1: orNull(at("ADMIN_CODE1")),
    latitude: numOrNull(at("LATITUDE")),
    longitude: numOrNull(at("LONGITUDE")),
  };
};

type CountryRow = {
  code: string;
  code3: string | null;
  name: string;
  capital: string | null;
  continent: string | null;
  currency_code: string | null;
  /** Postgres array literal e.g. `{"de","en"}` — Bun's sql doesn't auto-cast JS arrays to text[]. */
  languages: string;
  calling_code: string | null;
  flag_emoji: string | null;
};

const COUNTRIES_REQUIRED = ["CODE", "NAME"] as const;

const mapCountry: RowMapper<CountryRow> = (cols, h) => {
  const at = (k: string): string | undefined => cols[h.get(k)!];
  const langs = (at("LANGUAGES") ?? "")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return {
    code: at("CODE") ?? "",
    code3: orNull(at("CODE3")),
    name: at("NAME") ?? "",
    capital: orNull(at("CAPITAL")),
    continent: orNull(at("CONTINENT")),
    currency_code: orNull(at("CURRENCY_CODE")),
    languages: toPgTextArray(langs),
    calling_code: orNull(at("CALLING_CODE")),
    flag_emoji: orNull(at("FLAG_EMOJI")),
  };
};

type AliasRow = {
  geonameid: number;
  kind: string;
  lang: string | null;
  value: string;
  is_preferred: boolean;
};

const ALIASES_REQUIRED = ["GEONAMEID", "KIND", "VALUE"] as const;

const mapAlias: RowMapper<AliasRow> = (cols, h, ctx) => {
  const at = (k: string): string | undefined => cols[h.get(k)!];
  const where = `${ctx.filename}:${ctx.lineNo}`;
  const id = numOrThrow(at("GEONAMEID"), "geonameid", where);
  return {
    geonameid: id,
    kind: at("KIND") ?? "",
    lang: orNull(at("LANG")),
    value: at("VALUE") ?? "",
    is_preferred: at("IS_PREFERRED") === "1",
  };
};

// ─── orchestration: verify-all → atomic ingest ───────────────────────────────

type IngestCounts = {
  places: number;
  postal_codes: number;
  countries: number;
  addresses: number;
  aliases: number;
};

const ingestInto = async <TRow>(
  tx: SQL,
  table:
    | "geomark.places"
    | "geomark.addresses"
    | "geomark.postal_codes"
    | "geomark.countries"
    | "geomark.place_aliases",
  path: string,
  filename: string,
  required: readonly string[],
  mapRow: RowMapper<TRow>,
): Promise<number> => {
  let count = 0;
  for await (const batch of streamCsvBatches(path, filename, required, mapRow)) {
    if (table === "geomark.places")
      await tx`INSERT INTO geomark.places ${tx(batch)}`;
    else if (table === "geomark.addresses")
      await tx`INSERT INTO geomark.addresses ${tx(batch)}`;
    else if (table === "geomark.postal_codes")
      await tx`INSERT INTO geomark.postal_codes ${tx(batch)}`;
    else if (table === "geomark.place_aliases")
      await tx`INSERT INTO geomark.place_aliases ${tx(batch)}`;
    else
      await tx`INSERT INTO geomark.countries ${tx(batch)}`;
    count += batch.length;
  }
  return count;
};

const clearActiveTables = async (tx: SQL): Promise<void> => {
  // DELETE keeps MVCC readers on the old committed dataset while the refresh
  // transaction loads the new one. Table-level truncation would take ACCESS
  // EXCLUSIVE locks and can stall public reads for the full ingest duration.
  await tx`DELETE FROM geomark.coverage`;
  await tx`DELETE FROM geomark.place_aliases`;
  await tx`DELETE FROM geomark.addresses`;
  await tx`DELETE FROM geomark.postal_codes`;
  await tx`DELETE FROM geomark.countries`;
  await tx`DELETE FROM geomark.places`;
};

const materializeReferenceState = async (
  tx: SQL,
  counts: IngestCounts,
  manifest: Manifest,
  fingerprint: string,
): Promise<void> => {
  await tx`UPDATE geomark.countries SET place_count = 0`;
  await tx`
    UPDATE geomark.countries c SET place_count = p.cnt
    FROM (
      SELECT country_code, COUNT(*)::int AS cnt
      FROM geomark.places
      WHERE country_code IS NOT NULL
      GROUP BY country_code
    ) p
    WHERE p.country_code = c.code
  `;
  await tx`DELETE FROM geomark.coverage`;
  await tx`
    INSERT INTO geomark.coverage (country_code, status)
    SELECT
      c.code,
      CASE
        WHEN EXISTS (SELECT 1 FROM geomark.addresses a WHERE a.country_code = c.code)
          THEN 'address'
        WHEN c.place_count > 0
          THEN 'place_only'
        ELSE 'none'
      END AS status
    FROM geomark.countries c
  `;
  await tx`
    UPDATE geomark.meta SET
      dataset_version    = ${manifest.version},
      manifest_sha256    = ${fingerprint},
      loaded_at          = NOW(),
      places_count       = ${counts.places},
      addresses_count    = ${counts.addresses},
      postal_codes_count = ${counts.postal_codes},
      countries_count    = ${counts.countries},
      aliases_count      = ${counts.aliases}
    WHERE id = TRUE
  `;
};

/**
 * Full atomic refresh:
 *   1. Download every file to a temp dir + SHA-verify. If any fails, throw
 *      before touching the DB (the previous dataset stays valid).
 *   2. Open a single transaction: DELETE active rows, stream-INSERT the new
 *      dataset, materialize stable reference state, then UPDATE meta. MVCC
 *      readers see the old committed dataset until the transaction commits.
 *   3. Cleanup temp files in `finally`.
 */
export const ingestAll = async (
  baseUrl: string,
  manifest: Manifest,
  fingerprint: string,
): Promise<IngestCounts> => {
  const tempDir = await mkdtemp(join(tmpdir(), "geomark-loader-"));

  try {
    // 1. Verify everything before opening the txn.
    const placesPath = await fetchAndVerifyToFile(
      `${baseUrl}/${manifest.files.places.filename}`,
      manifest.files.places.sha256,
      tempDir,
      manifest.files.places.filename,
    );
    const postalPath = await fetchAndVerifyToFile(
      `${baseUrl}/${manifest.files.postal_codes.filename}`,
      manifest.files.postal_codes.sha256,
      tempDir,
      manifest.files.postal_codes.filename,
    );
    const countriesPath = await fetchAndVerifyToFile(
      `${baseUrl}/${manifest.files.countries.filename}`,
      manifest.files.countries.sha256,
      tempDir,
      manifest.files.countries.filename,
    );
    const addressShards: { entry: AddressFileEntry; path: string }[] = [];
    for (const entry of manifest.files.addresses) {
      const path = await fetchAndVerifyToFile(
        `${baseUrl}/${entry.filename}`,
        entry.sha256,
        tempDir,
        entry.filename,
      );
      addressShards.push({ entry, path });
    }
    let aliasesPath: string | undefined;
    if (manifest.files.aliases) {
      aliasesPath = await fetchAndVerifyToFile(
        `${baseUrl}/${manifest.files.aliases.filename}`,
        manifest.files.aliases.sha256,
        tempDir,
        manifest.files.aliases.filename,
      );
    }

    // 2. Atomic ingest + meta update.
    const counts: IngestCounts = {
      places: 0,
      postal_codes: 0,
      countries: 0,
      addresses: 0,
      aliases: 0,
    };
    await sql.begin(async (tx) => {
      await clearActiveTables(tx);
      counts.places = await ingestInto(
        tx, "geomark.places", placesPath,
        manifest.files.places.filename, PLACES_REQUIRED, mapPlace,
      );
      counts.postal_codes = await ingestInto(
        tx, "geomark.postal_codes", postalPath,
        manifest.files.postal_codes.filename, POSTAL_REQUIRED, mapPostal,
      );
      counts.countries = await ingestInto(
        tx, "geomark.countries", countriesPath,
        manifest.files.countries.filename, COUNTRIES_REQUIRED, mapCountry,
      );
      for (const { entry, path } of addressShards) {
        counts.addresses += await ingestInto(
          tx, "geomark.addresses", path,
          entry.filename, ADDRESSES_REQUIRED, mapAddress,
        );
      }
      if (aliasesPath && manifest.files.aliases) {
        counts.aliases = await ingestInto(
          tx, "geomark.place_aliases", aliasesPath,
          manifest.files.aliases.filename, ALIASES_REQUIRED, mapAlias,
        );
      }
      await materializeReferenceState(tx, counts, manifest, fingerprint);
    });
    return counts;
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
};
