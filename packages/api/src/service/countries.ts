import { sql } from "bun";
import type { Country } from "@geomark/shared";
import { err, fail, ok, type Result } from "../lib/respond";

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
    COALESCE(p.cnt, 0) AS place_count
  FROM geomark.countries c
  LEFT JOIN (
    SELECT country_code, COUNT(*)::int AS cnt
    FROM geomark.places
    WHERE country_code IS NOT NULL
    GROUP BY country_code
  ) p ON p.country_code = c.code
`;

export const listCountries = async (): Promise<
  Result<{ countries: Country[]; total: number }>
> => {
  const rows = await sql<DbRow[]>`
    ${COUNTRIES_QUERY}
    ORDER BY c.name
  `;
  return ok({
    countries: rows.map(mapCountry),
    total: rows.length,
  });
};

export const getCountry = async (code: string): Promise<Result<Country>> => {
  const upper = code.toUpperCase();
  const rows = await sql<DbRow[]>`
    ${COUNTRIES_QUERY}
    WHERE c.code = ${upper}
    LIMIT 1
  `;
  if (rows.length === 0) {
    return fail(err.notFound(`country not found: ${upper}`));
  }
  return ok(mapCountry(rows[0]!));
};
