import { sql } from "bun";
import type {
  Feature,
  FeatureLayer,
  SearchQuerySchema,
} from "@geomark/shared";
import type { z } from "zod";
import { ok, type Result } from "../lib/respond";

type SearchInput = z.infer<typeof SearchQuerySchema>;
type Bbox = { minLng: number; minLat: number; maxLng: number; maxLat: number };

const DEFAULT_LIMIT = 10;
const PER_TABLE_FETCH_MULTIPLIER = 2; // over-fetch per table, then merge & cap

// ─── shared SQL fragments ────────────────────────────────────────────────────

const filterFragment = (
  country: string | undefined,
  bbox: Bbox | undefined,
) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parts: any[] = [];
  if (country) parts.push(sql`country_code = ${country}`);
  if (bbox) {
    parts.push(
      sql`geom && ST_MakeEnvelope(${bbox.minLng}, ${bbox.minLat}, ${bbox.maxLng}, ${bbox.maxLat}, 4326)`,
    );
  }
  if (parts.length === 0) return sql`TRUE`;
  return parts.reduce((acc, p) => sql`${acc} AND ${p}`);
};

// ─── per-table queries ───────────────────────────────────────────────────────
//
// Strategy: TWO separate queries per table — one for BM25 candidates, one
// for trigram candidates — then dedup in JS. Each query takes the index
// path it was designed for: BM25 sort uses pg_textsearch's optimized top-k,
// trigram filter uses the GIN trgm index. We tier results: BM25 hits first
// (ranked by bm25 score, smaller = better), then trgm-only fallbacks.

type Hit = {
  gid: string;
  layer: FeatureLayer;
  name: string;
  label: string;
  latitude: number;
  longitude: number;
  country_code: string | null;
  bm25: number | null;       // null when not from BM25 branch
  trgm: number;              // 0..1
  population: number | null; // places only
  distance_m: number | null;
  /** Populated when the row was matched via place_aliases, not direct name. */
  matched_alias_kind: string | null;
  matched_alias_lang: string | null;
  matched_alias_value: string | null;
};

const placeBm25 = async (
  q: string,
  filter: ReturnType<typeof filterFragment>,
  proximityPoint: ReturnType<typeof filterFragment> | null,
  limit: number,
): Promise<Hit[]> => {
  const distExpr = proximityPoint
    ? sql`ST_DistanceSphere(geom, ${proximityPoint})`
    : sql`NULL::double precision`;
  const rows = await sql<Hit[]>`
    SELECT
      gid, 'locality'::text AS layer, name, name AS label,
      latitude, longitude, country_code, population,
      (search_text <@> to_bm25query(${q}, 'geomark.idx_places_search_bm25')) AS bm25,
      similarity(search_text, geomark.f_unaccent(lower(${q}))) AS trgm,
      ${distExpr} AS distance_m,
      NULL::text AS matched_alias_kind,
      NULL::text AS matched_alias_lang,
      NULL::text AS matched_alias_value
    FROM geomark.places
    WHERE ${filter}
      AND (search_text <@> to_bm25query(${q}, 'geomark.idx_places_search_bm25')) < 0
    ORDER BY (search_text <@> to_bm25query(${q}, 'geomark.idx_places_search_bm25')) ASC
    LIMIT ${limit}
  `;
  return rows;
};

const placeTrgm = async (
  q: string,
  filter: ReturnType<typeof filterFragment>,
  proximityPoint: ReturnType<typeof filterFragment> | null,
  limit: number,
): Promise<Hit[]> => {
  const distExpr = proximityPoint
    ? sql`ST_DistanceSphere(geom, ${proximityPoint})`
    : sql`NULL::double precision`;
  const rows = await sql<Hit[]>`
    SELECT
      gid, 'locality'::text AS layer, name, name AS label,
      latitude, longitude, country_code, population,
      NULL::double precision AS bm25,
      similarity(search_text, geomark.f_unaccent(lower(${q}))) AS trgm,
      ${distExpr} AS distance_m,
      NULL::text AS matched_alias_kind,
      NULL::text AS matched_alias_lang,
      NULL::text AS matched_alias_value
    FROM geomark.places
    WHERE ${filter}
      AND search_text % geomark.f_unaccent(lower(${q}))
    ORDER BY similarity(search_text, geomark.f_unaccent(lower(${q}))) DESC
    LIMIT ${limit}
  `;
  return rows;
};

// Alias-driven hits: find matching aliases, JOIN back to places. Only
// scans rows where the partial trgm/bm25 indexes apply (kind IN
// 'name','abbr'). Joined places are scoped by the same country/bbox
// filter the direct branches use, applied to the JOINed places row.
const placeAliasBm25 = async (
  q: string,
  filter: ReturnType<typeof filterFragment>,
  proximityPoint: ReturnType<typeof filterFragment> | null,
  limit: number,
): Promise<Hit[]> => {
  const distExpr = proximityPoint
    ? sql`ST_DistanceSphere(p.geom, ${proximityPoint})`
    : sql`NULL::double precision`;
  const rows = await sql<Hit[]>`
    SELECT
      p.gid, 'locality'::text AS layer, p.name, p.name AS label,
      p.latitude, p.longitude, p.country_code, p.population,
      (a.search_text <@> to_bm25query(${q}, 'geomark.idx_aliases_search_bm25')) AS bm25,
      similarity(a.search_text, geomark.f_unaccent(lower(${q}))) AS trgm,
      ${distExpr} AS distance_m,
      a.kind AS matched_alias_kind,
      a.lang AS matched_alias_lang,
      a.value AS matched_alias_value
    FROM geomark.place_aliases a
    JOIN geomark.places p ON p.gid = 'geonames:' || a.geonameid
    WHERE a.search_text IS NOT NULL
      AND (a.search_text <@> to_bm25query(${q}, 'geomark.idx_aliases_search_bm25')) < 0
      AND (${filter})
    ORDER BY (a.search_text <@> to_bm25query(${q}, 'geomark.idx_aliases_search_bm25')) ASC
    LIMIT ${limit}
  `;
  return rows;
};

const placeAliasTrgm = async (
  q: string,
  filter: ReturnType<typeof filterFragment>,
  proximityPoint: ReturnType<typeof filterFragment> | null,
  limit: number,
): Promise<Hit[]> => {
  const distExpr = proximityPoint
    ? sql`ST_DistanceSphere(p.geom, ${proximityPoint})`
    : sql`NULL::double precision`;
  const rows = await sql<Hit[]>`
    SELECT
      p.gid, 'locality'::text AS layer, p.name, p.name AS label,
      p.latitude, p.longitude, p.country_code, p.population,
      NULL::double precision AS bm25,
      similarity(a.search_text, geomark.f_unaccent(lower(${q}))) AS trgm,
      ${distExpr} AS distance_m,
      a.kind AS matched_alias_kind,
      a.lang AS matched_alias_lang,
      a.value AS matched_alias_value
    FROM geomark.place_aliases a
    JOIN geomark.places p ON p.gid = 'geonames:' || a.geonameid
    WHERE a.search_text IS NOT NULL
      AND a.search_text % geomark.f_unaccent(lower(${q}))
      AND (${filter})
    ORDER BY similarity(a.search_text, geomark.f_unaccent(lower(${q}))) DESC
    LIMIT ${limit}
  `;
  return rows;
};

const addressBm25 = async (
  q: string,
  filter: ReturnType<typeof filterFragment>,
  proximityPoint: ReturnType<typeof filterFragment> | null,
  limit: number,
): Promise<Hit[]> => {
  const distExpr = proximityPoint
    ? sql`ST_DistanceSphere(geom, ${proximityPoint})`
    : sql`NULL::double precision`;
  const rows = await sql<Hit[]>`
    SELECT
      gid, 'address'::text AS layer,
      COALESCE(NULLIF(TRIM(CONCAT_WS(' ', house_number, street)), ''), label) AS name,
      label, latitude, longitude, country_code,
      NULL::bigint AS population,
      (search_text <@> to_bm25query(${q}, 'geomark.idx_addresses_search_bm25')) AS bm25,
      similarity(search_text, geomark.f_unaccent(lower(${q}))) AS trgm,
      ${distExpr} AS distance_m,
      NULL::text AS matched_alias_kind,
      NULL::text AS matched_alias_lang,
      NULL::text AS matched_alias_value
    FROM geomark.addresses
    WHERE ${filter}
      AND (search_text <@> to_bm25query(${q}, 'geomark.idx_addresses_search_bm25')) < 0
    ORDER BY (search_text <@> to_bm25query(${q}, 'geomark.idx_addresses_search_bm25')) ASC
    LIMIT ${limit}
  `;
  return rows;
};

const addressTrgm = async (
  q: string,
  filter: ReturnType<typeof filterFragment>,
  proximityPoint: ReturnType<typeof filterFragment> | null,
  limit: number,
): Promise<Hit[]> => {
  const distExpr = proximityPoint
    ? sql`ST_DistanceSphere(geom, ${proximityPoint})`
    : sql`NULL::double precision`;
  const rows = await sql<Hit[]>`
    SELECT
      gid, 'address'::text AS layer,
      COALESCE(NULLIF(TRIM(CONCAT_WS(' ', house_number, street)), ''), label) AS name,
      label, latitude, longitude, country_code,
      NULL::bigint AS population,
      NULL::double precision AS bm25,
      similarity(search_text, geomark.f_unaccent(lower(${q}))) AS trgm,
      ${distExpr} AS distance_m,
      NULL::text AS matched_alias_kind,
      NULL::text AS matched_alias_lang,
      NULL::text AS matched_alias_value
    FROM geomark.addresses
    WHERE ${filter}
      AND search_text % geomark.f_unaccent(lower(${q}))
    ORDER BY similarity(search_text, geomark.f_unaccent(lower(${q}))) DESC
    LIMIT ${limit}
  `;
  return rows;
};

// ─── ranking + merge ─────────────────────────────────────────────────────────

/**
 * Tiered ranking: BM25 matches always beat trigram-only matches. Within
 * each tier:
 *   - BM25 tier sorted by bm25 ASC (smaller = more relevant)
 *   - trgm tier sorted by trgm DESC
 * Tie-breakers: distance_m ASC (when proximity set), population DESC.
 */
const rank = (a: Hit, b: Hit): number => {
  const aIsBm25 = a.bm25 !== null;
  const bIsBm25 = b.bm25 !== null;
  if (aIsBm25 !== bIsBm25) return aIsBm25 ? -1 : 1;
  if (aIsBm25) {
    if (a.bm25! !== b.bm25!) return a.bm25! - b.bm25!; // smaller better
  } else {
    if (a.trgm !== b.trgm) return b.trgm - a.trgm;
  }
  const ad = a.distance_m ?? Infinity;
  const bd = b.distance_m ?? Infinity;
  if (ad !== bd) return ad - bd;
  const ap = a.population ?? -Infinity;
  const bp = b.population ?? -Infinity;
  return bp - ap;
};

/**
 * Translate internal Hit ranking into the public Feature.score [0..]:
 *   - BM25 hit  → -bm25 (positive magnitude; larger = more relevant)
 *   - trgm hit  →  trgm * 0.6 (capped under typical BM25 magnitudes)
 */
const scoreOf = (h: Hit): number =>
  h.bm25 !== null ? -h.bm25 : h.trgm * 0.6;

// ─── public API ──────────────────────────────────────────────────────────────

export const search = async (
  input: SearchInput,
): Promise<Result<{ features: Feature[]; total: number }>> => {
  // Sanitize: trim + reject blank/whitespace-only queries before SQL.
  // pg_textsearch's tokenizer rejects pure-whitespace and we don't want
  // a 500 from the route layer.
  const q = input.q.trim();
  if (q.length === 0) return ok({ features: [], total: 0 });

  const layers: FeatureLayer[] = input.layers ?? ["address", "locality"];
  const limit = input.limit ?? DEFAULT_LIMIT;
  const perTable = limit * PER_TABLE_FETCH_MULTIPLIER;

  const filter = filterFragment(input.country, input.bbox);
  const proximityPoint =
    input.proximity_lat !== undefined && input.proximity_lng !== undefined
      ? sql`ST_SetSRID(ST_MakePoint(${input.proximity_lng}, ${input.proximity_lat}), 4326)`
      : null;

  // Sequential per branch. Tried `Promise.all` here — exhausts Bun's
  // default 10-connection pool under load (each /search wants up to 6
  // concurrent connections × N concurrent requests = pool deadlock).
  // Pool size isn't configurable via DATABASE_URL in Bun (only via
  // `new SQL(url, {max})` constructor, which would mean refactoring
  // away from the implicit module-level sql). Sequential is safe at
  // any pool size and the per-query latency dominates RTT anyway.
  const all: Hit[] = [];
  if (layers.includes("locality")) {
    all.push(...(await placeBm25(q, filter, proximityPoint, perTable)));
    all.push(...(await placeTrgm(q, filter, proximityPoint, perTable)));
    // Alias branches contribute multilingual / abbreviation hits. The
    // partial trgm + bm25 indexes guarantee these scan only kind IN
    // ('name','abbr'). Empty when no aliases dataset is loaded.
    all.push(...(await placeAliasBm25(q, filter, proximityPoint, perTable)));
    all.push(...(await placeAliasTrgm(q, filter, proximityPoint, perTable)));
  }
  if (layers.includes("address")) {
    all.push(...(await addressBm25(q, filter, proximityPoint, perTable)));
    all.push(...(await addressTrgm(q, filter, proximityPoint, perTable)));
  }

  // Dedup by gid:
  //   1. Tier: BM25 hits always beat trgm-only.
  //   2. Within a tier: better RELEVANCE wins (smaller bm25 / higher trgm).
  //      A weak direct hit must NOT suppress a strong alias hit.
  //   3. Tied relevance: prefer the direct (non-alias) hit so the row's
  //      matched_alias stays null when nothing meaningful was matched.
  const byGid = new Map<string, Hit>();
  const better = (cur: Hit, prev: Hit): boolean => {
    const curIsBm25 = cur.bm25 !== null;
    const prevIsBm25 = prev.bm25 !== null;
    if (curIsBm25 !== prevIsBm25) return curIsBm25;
    if (curIsBm25) {
      if (cur.bm25! !== prev.bm25!) return cur.bm25! < prev.bm25!; // smaller better
    } else {
      if (cur.trgm !== prev.trgm) return cur.trgm > prev.trgm; // higher better
    }
    // Tied relevance — keep direct over alias-routed.
    return prev.matched_alias_kind !== null && cur.matched_alias_kind === null;
  };
  for (const h of all) {
    const prev = byGid.get(h.gid);
    if (!prev || better(h, prev)) byGid.set(h.gid, h);
  }

  let sorted = Array.from(byGid.values()).sort(rank).slice(0, limit);

  // Optional: localize name + label via prefer_lang aliases. We query
  // place_aliases by raw bigint geonameid (uses idx_aliases_lang_kind +
  // idx_aliases_geonameid) and let DISTINCT ON pick the deterministic
  // preferred row per gid. Done after limit so we hydrate ≤ limit rows.
  if (input.prefer_lang && sorted.length > 0) {
    const ids = sorted
      .map((h) => h.gid.match(/^geonames:(\d+)$/)?.[1])
      .filter((s): s is string => Boolean(s));
    if (ids.length > 0) {
      // Format as Postgres bigint array literal — Bun's sql can't auto-
      // cast JS arrays to typed arrays.
      const idsLiteral = `{${ids.join(",")}}`;
      type LocRow = { geonameid: number; localized: string };
      const rows = await sql<LocRow[]>`
        SELECT DISTINCT ON (a.geonameid)
          a.geonameid, a.value AS localized
        FROM geomark.place_aliases a
        WHERE a.kind = 'name'
          AND a.lang = ${input.prefer_lang}
          AND a.geonameid = ANY(${idsLiteral}::bigint[])
        ORDER BY a.geonameid, a.is_preferred DESC, a.id ASC
      `;
      const byGidLoc = new Map<string, string>();
      for (const r of rows) {
        byGidLoc.set(`geonames:${r.geonameid}`, r.localized);
      }
      sorted = sorted.map((h) => {
        const localized = byGidLoc.get(h.gid);
        return localized ? { ...h, name: localized, label: localized } : h;
      });
    }
  }

  const features: Feature[] = sorted.map((h) => ({
    gid: h.gid,
    layer: h.layer,
    name: h.name,
    label: h.label,
    latitude: h.latitude,
    longitude: h.longitude,
    country_code: h.country_code,
    score: Number(scoreOf(h)),
    ...(h.distance_m != null
      ? { distance_km: Number(h.distance_m) / 1000 }
      : {}),
    ...(h.matched_alias_kind != null
      ? {
          matched_alias: {
            kind: h.matched_alias_kind,
            lang: h.matched_alias_lang,
            value: h.matched_alias_value ?? "",
          },
        }
      : {}),
  }));

  return ok({ features, total: features.length });
};
