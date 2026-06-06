import { sql } from "bun";
import { ok, type Result } from "../lib/respond";

type CoverageStatus = "address" | "place_only" | "none";

/**
 * Coverage report: per ISO country code, the deepest data layer we have.
 *   address    → at least one row in geomark.addresses
 *   place_only → at least one row in geomark.places, but no addresses
 *   none       → country exists in geomark.countries but no places/addresses
 */
export const getCoverage = async (): Promise<
  Result<{ countries: Record<string, CoverageStatus> }>
> => {
  const rows = await sql<
    { code: string; has_addresses: boolean; has_places: boolean }[]
  >`
    SELECT
      c.code,
      EXISTS (SELECT 1 FROM geomark.addresses a WHERE a.country_code = c.code) AS has_addresses,
      EXISTS (SELECT 1 FROM geomark.places   p WHERE p.country_code = c.code) AS has_places
    FROM geomark.countries c
    ORDER BY c.code
  `;

  const out: Record<string, CoverageStatus> = {};
  for (const r of rows) {
    if (r.has_addresses) out[r.code] = "address";
    else if (r.has_places) out[r.code] = "place_only";
    else out[r.code] = "none";
  }
  return ok({ countries: out });
};
