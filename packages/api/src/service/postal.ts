import { sql } from "bun";
import type { PostalCode, PostalQuerySchema } from "@geomark/shared";
import type { z } from "zod";
import { err, fail, ok, type Result } from "../lib/respond";

type PostalInput = z.infer<typeof PostalQuerySchema>;
type DbRow = Record<string, unknown>;

const DEFAULT_LIMIT = 20;

const mapPostal = (row: DbRow): PostalCode => ({
  country_code: row.country_code as string,
  postal_code: row.postal_code as string,
  place_name: (row.place_name ?? null) as string | null,
  admin_name1: (row.admin_name1 ?? null) as string | null,
  admin_code1: (row.admin_code1 ?? null) as string | null,
  latitude: (row.latitude ?? null) as number | null,
  longitude: (row.longitude ?? null) as number | null,
});

export const queryPostal = async (
  input: PostalInput,
): Promise<Result<{ postal_codes: PostalCode[]; total: number }>> => {
  const limit = input.limit ?? DEFAULT_LIMIT;

  // Defense-in-depth: PostalQuerySchema enforces at-least-one of code/place,
  // but the service is exported and could be called directly. Reject early
  // with BAD_INPUT instead of letting `conditions.reduce()` throw on empty.
  if (!input.code && !input.place) {
    return fail(
      err.badInput("at least one of `code` or `place` must be provided"),
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const conditions: any[] = [];
  if (input.code) conditions.push(sql`postal_code = ${input.code}`);
  if (input.place) {
    conditions.push(
      sql`geomark.f_unaccent(lower(place_name)) % geomark.f_unaccent(lower(${input.place}))`,
    );
  }
  if (input.country) conditions.push(sql`country_code = ${input.country}`);
  const where = conditions.reduce((acc, c) => sql`${acc} AND ${c}`);

  const rows = await sql<DbRow[]>`
    SELECT country_code, postal_code, place_name, admin_name1, admin_code1, latitude, longitude
    FROM geomark.postal_codes
    WHERE ${where}
    ORDER BY country_code, postal_code, place_name
    LIMIT ${limit}
  `;

  return ok({
    postal_codes: rows.map(mapPostal),
    total: rows.length,
  });
};
