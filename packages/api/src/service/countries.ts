import { sql } from "bun";
import type { Country } from "@geomark/shared";
import { err, fail, ok, type Result } from "../lib/respond";
import { config } from "../config";
import { cacheGetJson, cacheSetJson } from "../lib/redis";
import { currentDatasetVersion } from "./meta";

type DbRow = Record<string, unknown>;

const mapCountry = (row: DbRow): Country => ({
  code: row.code as string,
  code3: (row.code3 ?? null) as string | null,
  name: row.name as string,
  capital: (row.capital ?? null) as string | null,
  continent: (row.continent ?? null) as string | null,
  currency_code: (row.currency_code ?? null) as string | null,
  languages: (row.languages ?? []) as string[],
  calling_code: (row.calling_code ?? null) as string | null,
  flag_emoji: (row.flag_emoji ?? null) as string | null,
  place_count: Number(row.place_count ?? 0),
});

const COUNTRIES_QUERY = sql`
  SELECT
    c.code, c.code3, c.name, c.capital, c.continent, c.currency_code,
    c.languages, c.calling_code, c.flag_emoji,
    c.place_count
  FROM geomark.countries c
`;

const countriesCacheKey = (version: string): string =>
  `geomark:cache:countries:${version}`;

const readCountries = async (): Promise<Country[]> => {
  const rows = await sql<DbRow[]>`
    ${COUNTRIES_QUERY}
    ORDER BY c.name
  `;
  return rows.map(mapCountry);
};

const getCachedCountries = async (): Promise<Country[]> => {
  const version = await currentDatasetVersion();
  const key = countriesCacheKey(version);
  try {
    const cached = await cacheGetJson<Country[]>(key, "countries");
    if (cached) return cached;
  } catch (err) {
    console.warn("[countries] Redis cache read failed:", err);
  }

  const countries = await readCountries();
  try {
    await cacheSetJson(key, countries, config.referenceCacheSeconds, "countries");
  } catch (err) {
    console.warn("[countries] Redis cache write failed:", err);
  }
  return countries;
};

export const listCountries = async (): Promise<
  Result<{ countries: Country[]; total: number }>
> => {
  const countries = await getCachedCountries();
  return ok({
    countries,
    total: countries.length,
  });
};

export const getCountry = async (code: string): Promise<Result<Country>> => {
  const upper = code.toUpperCase();
  const country = (await getCachedCountries()).find((c) => c.code === upper);
  if (!country) {
    return fail(err.notFound(`country not found: ${upper}`));
  }
  return ok(country);
};
