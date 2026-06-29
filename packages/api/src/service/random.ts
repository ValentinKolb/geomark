import { sql } from "bun";
import type { RandomQuery, RandomResponse } from "@geomark/shared";
import { ok, type Result } from "../lib/respond";
import { config } from "../config";
import { cacheGetJson, cacheSetJson } from "../lib/redis";
import { currentDatasetVersion } from "./meta";

/**
 * Random sample of places from the dataset.
 *
 * Filters: `country` (ISO 3166-1 alpha-2), `min_population`. Returns up
 * to `limit` rows in random order — useful for visualisations, sampling,
 * and dataset exploration.
 *
 * The hot path uses an indexed `sample_key` window scan plus wraparound, not
 * a full-table random sort. The homepage's default sample is also short-TTL
 * cached in Redis so many visitors share one payload.
 */
type DbRow = {
  gid: string;
  name: string;
  latitude: number;
  longitude: number;
  country_code: string | null;
  population: bigint | null;
};

const mapResponse = (rows: DbRow[]): RandomResponse => ({
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

const cacheKey = (
  version: string,
  limit: number,
  country: string | null,
  minPopulation: number | null,
): string =>
  `geomark:cache:random:${version}:${limit}:${country ?? "all"}:${minPopulation ?? "all"}`;

const filterFragment = (
  country: string | null,
  minPopulation: number | null,
) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parts: any[] = [];
  if (country) parts.push(sql`country_code = ${country}`);
  if (minPopulation !== null) {
    parts.push(sql`population IS NOT NULL AND population >= ${minPopulation}::bigint`);
  }
  if (parts.length === 0) return sql`TRUE`;
  return parts.reduce((acc, p) => sql`${acc} AND ${p}`);
};

const queryWindow = async (
  seed: number,
  limit: number,
  country: string | null,
  minPopulation: number | null,
): Promise<DbRow[]> => {
  const where = filterFragment(country, minPopulation);
  const first = await sql<DbRow[]>`
    SELECT gid, name, latitude, longitude, country_code, population
    FROM geomark.places
    WHERE ${where} AND sample_key >= ${seed}
    ORDER BY sample_key ASC
    LIMIT ${limit}
  `;
  if (first.length >= limit) return first;

  const remaining = limit - first.length;
  const second = await sql<DbRow[]>`
    SELECT gid, name, latitude, longitude, country_code, population
    FROM geomark.places
    WHERE ${where} AND sample_key < ${seed}
    ORDER BY sample_key ASC
    LIMIT ${remaining}
  `;
  return [...first, ...second];
};

export const random = async (
  q: RandomQuery,
): Promise<Result<RandomResponse>> => {
  const limit = q.limit ?? 500;
  const cc = q.country ?? null;
  const minPop = q.min_population ?? null;
  const version = await currentDatasetVersion();
  const key = cacheKey(version, limit, cc, minPop);

  try {
    const cached = await cacheGetJson<RandomResponse>(key, "random");
    if (cached) return ok(cached);
  } catch (err) {
    console.warn("[random] Redis cache read failed:", err);
  }

  const rows = await queryWindow(Math.random(), limit, cc, minPop);
  const body = mapResponse(rows);

  try {
    await cacheSetJson(key, body, config.randomCacheSeconds, "random");
  } catch (err) {
    console.warn("[random] Redis cache write failed:", err);
  }

  return ok(body);
};
