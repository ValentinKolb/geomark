import { sql } from "bun";
import type { RandomQuery, RandomResponse } from "@geomark/shared";
import { ok, type Result } from "../lib/respond";

/**
 * Random sample of places from the dataset.
 *
 * Filters: `country` (ISO 3166-1 alpha-2), `min_population`. Returns up
 * to `limit` rows in random order — useful for visualisations, sampling,
 * and dataset exploration.
 *
 * On large tables `ORDER BY random()` is a sequential scan; budget ~50ms
 * per 5000 rows on cities500. For the homepage map (typically 2000 rows
 * with no filters) this is well under the SSR budget.
 */
export const random = async (
  q: RandomQuery,
): Promise<Result<RandomResponse>> => {
  const limit = q.limit ?? 500;
  const cc = q.country ?? null;
  const minPop = q.min_population ?? null;

  const rows = await sql<
    {
      gid: string;
      name: string;
      latitude: number;
      longitude: number;
      country_code: string | null;
      // BIGINT comes back as a JS bigint in Bun.SQL; we coerce to number
      // because populations comfortably fit in a 53-bit float.
      population: bigint | null;
    }[]
  >`
    SELECT gid, name, latitude, longitude, country_code, population
    FROM geomark.places
    WHERE
      (${cc}::text   IS NULL OR country_code = ${cc}::text)
      AND (${minPop}::bigint IS NULL OR population >= ${minPop}::bigint)
    ORDER BY random()
    LIMIT ${limit}
  `;

  return ok({
    places: rows.map((r) => ({
      gid: r.gid,
      name: r.name,
      latitude: r.latitude,
      longitude: r.longitude,
      country_code: r.country_code,
      population: r.population != null ? Number(r.population) : null,
    })),
    total: rows.length,
  });
};
