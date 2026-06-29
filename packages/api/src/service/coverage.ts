import { sql } from "bun";
import { config } from "../config";
import { cacheGetJson, cacheSetJson } from "../lib/redis";
import { ok, type Result } from "../lib/respond";
import { currentDatasetVersion } from "./meta";

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
  const version = await currentDatasetVersion();
  const key = `geomark:cache:coverage:${version}`;
  try {
    const cached = await cacheGetJson<Record<string, CoverageStatus>>(
      key,
      "coverage",
    );
    if (cached) return ok({ countries: cached });
  } catch (err) {
    console.warn("[coverage] Redis cache read failed:", err);
  }

  const rows = await sql<{ code: string; status: CoverageStatus }[]>`
    SELECT country_code AS code, status::text AS status
    FROM geomark.coverage
    ORDER BY country_code
  `;

  const out: Record<string, CoverageStatus> = {};
  for (const r of rows) {
    out[r.code] = r.status;
  }

  try {
    await cacheSetJson(key, out, config.referenceCacheSeconds, "coverage");
  } catch (err) {
    console.warn("[coverage] Redis cache write failed:", err);
  }

  return ok({ countries: out });
};
