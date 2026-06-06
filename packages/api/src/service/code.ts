import { sql } from "bun";
import type { Place } from "@geomark/shared";
import { err, fail, ok, type Result } from "../lib/respond";

type DbRow = Record<string, unknown>;

const mapPlace = (row: DbRow): Place => ({
  gid: row.gid as string,
  name: row.name as string,
  asciiname: (row.asciiname ?? null) as string | null,
  latitude: row.latitude as number,
  longitude: row.longitude as number,
  feature_class: (row.feature_class ?? null) as string | null,
  feature_code: (row.feature_code ?? null) as string | null,
  country_code: (row.country_code ?? null) as string | null,
  admin1_code: (row.admin1_code ?? null) as string | null,
  admin2_code: (row.admin2_code ?? null) as string | null,
  population: (row.population != null
    ? Number(row.population)
    : null) as number | null,
  elevation: (row.elevation ?? null) as number | null,
  timezone: (row.timezone ?? null) as string | null,
});

/**
 * Reverse-lookup a place by alias kind + value.
 *
 * Examples:
 *   GET /code/iata/MUC   → Munich (geonames:2867714)
 *   GET /code/icao/EDDM  → Munich
 *   GET /code/abbr/NYC   → New York City
 *
 * Case-insensitive on `value` (uses the (kind, lower(value)) index).
 */
export const lookupByCode = async (
  kind: string,
  value: string,
): Promise<Result<Place>> => {
  // Several `kind` values (name, abbr, post, …) are not globally unique.
  // Codes like iata/icao are usually unique but exceptions exist. The
  // ORDER BY chain picks a deterministic winner: preferred alias →
  // most populous city → smallest gid.
  const rows = await sql<DbRow[]>`
    SELECT
      p.gid, p.name, p.asciiname, p.latitude, p.longitude,
      p.feature_class, p.feature_code, p.country_code,
      p.admin1_code, p.admin2_code, p.population, p.elevation, p.timezone
    FROM geomark.place_aliases a
    JOIN geomark.places p ON p.gid = 'geonames:' || a.geonameid
    WHERE a.kind = ${kind}
      AND lower(a.value) = lower(${value})
    ORDER BY a.is_preferred DESC, p.population DESC NULLS LAST, p.gid ASC
    LIMIT 1
  `;
  if (rows.length === 0) {
    return fail(err.notFound(`no place for ${kind}=${value}`));
  }
  return ok(mapPlace(rows[0]!));
};
