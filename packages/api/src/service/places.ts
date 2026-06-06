import { sql } from "bun";
import type { Alias, Place } from "@geomark/shared";
import { err, fail, ok, type Result } from "../lib/respond";

type DbPlace = Record<string, unknown>;
type DbAlias = Record<string, unknown>;

const mapPlace = (row: DbPlace): Place => ({
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

const mapAlias = (row: DbAlias): Alias => ({
  kind: row.kind as string,
  lang: (row.lang ?? null) as string | null,
  value: row.value as string,
  is_preferred: (row.is_preferred as boolean) ?? false,
});

/**
 * Get a place + all its aliases. Aliases come from geomark.place_aliases
 * which is empty unless the loader picked up an `aliases.csv.zst` artefact.
 * We extract the bare numeric geonameid from the gid prefix (`geonames:N`)
 * and join — works only for GeoNames-origin places.
 */
export const getPlace = async (
  gid: string,
): Promise<Result<{ place: Place; aliases: Alias[] }>> => {
  const rows = await sql<DbPlace[]>`
    SELECT
      gid, name, asciiname, latitude, longitude,
      feature_class, feature_code, country_code,
      admin1_code, admin2_code, population, elevation, timezone
    FROM geomark.places
    WHERE gid = ${gid}
    LIMIT 1
  `;
  if (rows.length === 0) {
    return fail(err.notFound(`place not found: ${gid}`));
  }
  const place = mapPlace(rows[0]!);

  // Fetch aliases only for GeoNames-origin gids (format `geonames:N`).
  // Other place sources won't have aliases anyway.
  let aliases: Alias[] = [];
  const m = /^geonames:(\d+)$/.exec(gid);
  if (m && m[1]) {
    const geonameid = Number(m[1]);
    const aliasRows = await sql<DbAlias[]>`
      SELECT kind, lang, value, is_preferred
      FROM geomark.place_aliases
      WHERE geonameid = ${geonameid}
      ORDER BY is_preferred DESC, kind, lang NULLS LAST, value
    `;
    aliases = aliasRows.map(mapAlias);
  }

  return ok({ place, aliases });
};
