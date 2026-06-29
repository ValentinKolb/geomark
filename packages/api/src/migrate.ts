import { sql } from "bun";

/**
 * Idempotent schema migration. Safe to call on every cold start.
 *
 * Important caveat: idempotent only against an unchanged target schema.
 * `IF NOT EXISTS` does not evolve already-existing tables/indexes whose
 * shape has changed. Schema evolution is not in scope for v0.1 — drop
 * the volume and re-migrate if the migration changes.
 *
 * Tables
 *   places         GeoNames cities (gid 'geonames:NNNN')
 *   addresses      OpenAddresses points (gid 'oa:CC_HASH')
 *   postal_codes   GeoNames postal codes (surrogate id; source has dups)
 *   countries      GeoNames country info
 *   coverage       Materialized per-country deepest available layer
 *   meta           single-row marker for the loaded dataset version
 *
 * Search strategy (hybrid BM25 + pg_trgm)
 *   Each searchable table has a `search_text` GENERATED column that holds
 *   `f_unaccent(lower(...))`. Both BM25 and trigram GIN are built over the
 *   SAME column, so /search can blend scores without a normalization
 *   mismatch.
 *
 * Spatial
 *   GEOMETRY(Point, 4326) primary, cast to ::geography for meter-accurate
 *   distance/radius queries (ST_DWithin, ST_DistanceSphere). GEOMETRY plays
 *   better with bbox and KNN ordering.
 */
export const migrate = async (): Promise<void> => {
  // ─── extensions ─────────────────────────────────────────────────────────────
  await sql`CREATE EXTENSION IF NOT EXISTS postgis`.simple();
  await sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`.simple();
  await sql`CREATE EXTENSION IF NOT EXISTS unaccent`.simple();
  await sql`CREATE EXTENSION IF NOT EXISTS pg_textsearch`.simple();

  // ─── schema ─────────────────────────────────────────────────────────────────
  await sql`CREATE SCHEMA IF NOT EXISTS geomark`.simple();

  // unaccent() is STABLE by default, so it can't be used in expression indexes
  // or generated columns. The wrapper marks it IMMUTABLE — valid as long as
  // the unaccent dictionary is treated as immutable. Reindex if rules change.
  await sql`
    CREATE OR REPLACE FUNCTION geomark.f_unaccent(text)
      RETURNS text AS $$ SELECT public.unaccent('public.unaccent', $1) $$
      LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  `.simple();

  // ─── meta (single-row marker for the loaded dataset) ────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS geomark.meta (
      id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id = TRUE),
      dataset_version TEXT,
      manifest_sha256 TEXT,
      loaded_at TIMESTAMPTZ,
      places_count INTEGER NOT NULL DEFAULT 0,
      addresses_count INTEGER NOT NULL DEFAULT 0,
      postal_codes_count INTEGER NOT NULL DEFAULT 0,
      countries_count INTEGER NOT NULL DEFAULT 0,
      aliases_count INTEGER NOT NULL DEFAULT 0
    )
  `.simple();
  await sql`ALTER TABLE geomark.meta ADD COLUMN IF NOT EXISTS places_count INTEGER NOT NULL DEFAULT 0`.simple();
  await sql`ALTER TABLE geomark.meta ADD COLUMN IF NOT EXISTS addresses_count INTEGER NOT NULL DEFAULT 0`.simple();
  await sql`ALTER TABLE geomark.meta ADD COLUMN IF NOT EXISTS postal_codes_count INTEGER NOT NULL DEFAULT 0`.simple();
  await sql`ALTER TABLE geomark.meta ADD COLUMN IF NOT EXISTS countries_count INTEGER NOT NULL DEFAULT 0`.simple();
  await sql`ALTER TABLE geomark.meta ADD COLUMN IF NOT EXISTS aliases_count INTEGER NOT NULL DEFAULT 0`.simple();
  await sql`INSERT INTO geomark.meta (id) VALUES (TRUE) ON CONFLICT DO NOTHING`.simple();

  // ─── places ─────────────────────────────────────────────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS geomark.places (
      gid              TEXT PRIMARY KEY,
      name             TEXT NOT NULL,
      asciiname        TEXT,
      latitude         DOUBLE PRECISION NOT NULL,
      longitude        DOUBLE PRECISION NOT NULL,
      geom             GEOMETRY(Point, 4326) GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)) STORED,
      feature_class    TEXT,
      feature_code     TEXT,
      country_code     TEXT,
      admin1_code      TEXT,
      admin2_code      TEXT,
      population       BIGINT,
      elevation        INTEGER,
      timezone         TEXT,
      sample_key       DOUBLE PRECISION NOT NULL DEFAULT random(),
      search_text      TEXT GENERATED ALWAYS AS (geomark.f_unaccent(lower(name))) STORED
    )
  `.simple();
  await sql`ALTER TABLE geomark.places ADD COLUMN IF NOT EXISTS sample_key DOUBLE PRECISION NOT NULL DEFAULT random()`.simple();
  await sql`CREATE INDEX IF NOT EXISTS idx_places_geom ON geomark.places USING GIST (geom)`.simple();
  await sql`CREATE INDEX IF NOT EXISTS idx_places_country ON geomark.places (country_code)`.simple();
  await sql`CREATE INDEX IF NOT EXISTS idx_places_sample_key ON geomark.places (sample_key)`.simple();
  await sql`CREATE INDEX IF NOT EXISTS idx_places_country_sample_key ON geomark.places (country_code, sample_key)`.simple();
  await sql`CREATE INDEX IF NOT EXISTS idx_places_search_trgm ON geomark.places USING GIN (search_text gin_trgm_ops)`.simple();
  await sql`CREATE INDEX IF NOT EXISTS idx_places_search_bm25 ON geomark.places USING bm25 (search_text) WITH (text_config='simple')`.simple();

  // ─── addresses ──────────────────────────────────────────────────────────────
  // `label` is computed by the loader from house_number/street/city/etc.
  // (OpenAddresses CSVs do not ship a single label field, so we synthesize it.)
  await sql`
    CREATE TABLE IF NOT EXISTS geomark.addresses (
      gid              TEXT PRIMARY KEY,
      latitude         DOUBLE PRECISION NOT NULL,
      longitude        DOUBLE PRECISION NOT NULL,
      geom             GEOMETRY(Point, 4326) GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)) STORED,
      house_number     TEXT,
      street           TEXT,
      unit             TEXT,
      city             TEXT,
      postcode         TEXT,
      region           TEXT,
      country_code     TEXT,
      label            TEXT NOT NULL,
      search_text      TEXT GENERATED ALWAYS AS (geomark.f_unaccent(lower(label))) STORED
    )
  `.simple();
  await sql`CREATE INDEX IF NOT EXISTS idx_addresses_geom ON geomark.addresses USING GIST (geom)`.simple();
  await sql`CREATE INDEX IF NOT EXISTS idx_addresses_country ON geomark.addresses (country_code)`.simple();
  await sql`CREATE INDEX IF NOT EXISTS idx_addresses_search_trgm ON geomark.addresses USING GIN (search_text gin_trgm_ops)`.simple();
  await sql`CREATE INDEX IF NOT EXISTS idx_addresses_search_bm25 ON geomark.addresses USING bm25 (search_text) WITH (text_config='simple')`.simple();

  // ─── postal_codes (GeoNames data has duplicates per (cc,code,place,admin*)) ─
  await sql`
    CREATE TABLE IF NOT EXISTS geomark.postal_codes (
      id               BIGSERIAL PRIMARY KEY,
      country_code     TEXT NOT NULL,
      postal_code      TEXT NOT NULL,
      place_name       TEXT,
      admin_name1      TEXT,
      admin_code1      TEXT,
      latitude         DOUBLE PRECISION,
      longitude        DOUBLE PRECISION,
      geom             GEOMETRY(Point, 4326) GENERATED ALWAYS AS (
        CASE WHEN latitude IS NOT NULL AND longitude IS NOT NULL
        THEN ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)
        END
      ) STORED
    )
  `.simple();
  await sql`CREATE INDEX IF NOT EXISTS idx_postal_code ON geomark.postal_codes (postal_code)`.simple();
  await sql`CREATE INDEX IF NOT EXISTS idx_postal_country_code ON geomark.postal_codes (country_code, postal_code)`.simple();
  await sql`CREATE INDEX IF NOT EXISTS idx_postal_geom ON geomark.postal_codes USING GIST (geom)`.simple();
  await sql`CREATE INDEX IF NOT EXISTS idx_postal_place_trgm ON geomark.postal_codes USING GIN (geomark.f_unaccent(lower(place_name)) gin_trgm_ops)`.simple();

  // ─── countries ──────────────────────────────────────────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS geomark.countries (
      code             TEXT PRIMARY KEY,
      code3            TEXT,
      name             TEXT NOT NULL,
      capital          TEXT,
      continent        TEXT,
      currency_code    TEXT,
      languages        TEXT[] NOT NULL DEFAULT '{}',
      calling_code     TEXT,
      flag_emoji       TEXT,
      place_count      INTEGER NOT NULL DEFAULT 0
    )
  `.simple();
  await sql`ALTER TABLE geomark.countries ADD COLUMN IF NOT EXISTS place_count INTEGER NOT NULL DEFAULT 0`.simple();

  // ─── coverage (materialized by the loader, stable between dataset refreshes) ─
  await sql`
    CREATE TABLE IF NOT EXISTS geomark.coverage (
      country_code TEXT PRIMARY KEY,
      status       TEXT NOT NULL CHECK (status IN ('address', 'place_only', 'none'))
    )
  `.simple();

  // ─── place_aliases (optional — populated only if data ships an aliases artefact) ─
  // One row per (place, alias-kind, value). Searchable kinds (name, abbr)
  // get a partial GIN trgm + BM25 index via the search_text generated
  // column. Non-searchable kinds (link, iata, post, …) only need the
  // (kind, value) reverse-lookup index.
  await sql`
    CREATE TABLE IF NOT EXISTS geomark.place_aliases (
      id               BIGSERIAL PRIMARY KEY,
      geonameid        BIGINT NOT NULL,
      kind             TEXT NOT NULL CHECK (kind <> ''),
      lang             TEXT,
      value            TEXT NOT NULL CHECK (value <> ''),
      is_preferred     BOOLEAN NOT NULL DEFAULT FALSE,
      search_text      TEXT GENERATED ALWAYS AS (
        CASE WHEN kind IN ('name', 'abbr')
        THEN geomark.f_unaccent(lower(value))
        END
      ) STORED
    )
  `.simple();
  await sql`CREATE INDEX IF NOT EXISTS idx_aliases_geonameid ON geomark.place_aliases (geonameid)`.simple();
  await sql`CREATE INDEX IF NOT EXISTS idx_aliases_kind_value ON geomark.place_aliases (kind, lower(value))`.simple();
  // Composite index supports the `prefer_lang` query in service/search.ts:
  // `WHERE kind='name' AND lang=$1 AND geonameid = ANY(...)`. Without
  // this, that query falls back to a seq scan on a busy alias table.
  // Replaces the older idx_aliases_lang_kind which served no live query.
  await sql`CREATE INDEX IF NOT EXISTS idx_aliases_prefer_lang ON geomark.place_aliases (kind, lang, geonameid, is_preferred DESC, id) WHERE lang IS NOT NULL`.simple();
  await sql`DROP INDEX IF EXISTS geomark.idx_aliases_lang_kind`.simple();
  await sql`CREATE INDEX IF NOT EXISTS idx_aliases_search_trgm ON geomark.place_aliases USING GIN (search_text gin_trgm_ops) WHERE search_text IS NOT NULL`.simple();
  await sql`CREATE INDEX IF NOT EXISTS idx_aliases_search_bm25 ON geomark.place_aliases USING bm25 (search_text) WITH (text_config='simple') WHERE search_text IS NOT NULL`.simple();
};
