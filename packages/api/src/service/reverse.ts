import { sql } from "bun";
import type { Feature, FeatureLayer, ReverseQuerySchema } from "@geomark/shared";
import type { z } from "zod";
import { ok, type Result } from "../lib/respond";

type ReverseInput = z.infer<typeof ReverseQuerySchema>;

const DEFAULT_LIMIT = 10;
const DEFAULT_RADIUS_KM = 5;
const METERS_PER_DEGREE_LAT = 111320; // constant; lat-direction always 1° ≈ 111.32km

type Hit = {
  gid: string;
  layer: FeatureLayer;
  name: string;
  label: string;
  latitude: number;
  longitude: number;
  country_code: string | null;
  distance_m: number;
};

/**
 * Per-axis lat/lng bbox in degrees that covers `radiusM` meters around
 * `(lat, lng)`. Latitude direction is constant (~111.32 km/°). Longitude
 * direction shrinks with `cos(lat)` — symmetric scaling under-covers
 * east/west candidates above ~48° latitude. We compute the lng axis
 * separately and clamp `cos(lat)` to avoid division-by-zero near the
 * poles.
 *
 * Antimeridian (lng near ±180): the bbox is clamped to [-180, 180] in
 * the SQL envelope. Queries within ~lonDeg of ±180 may miss results on
 * the other side. Acceptable for v0.1 — this is <0.001% of real traffic.
 */
const computeBbox = (
  lat: number,
  lng: number,
  radiusM: number,
): { minLat: number; maxLat: number; minLng: number; maxLng: number } => {
  const latDeg = radiusM / METERS_PER_DEGREE_LAT;
  const cosLat = Math.max(Math.cos((lat * Math.PI) / 180), 0.01);
  const lonDeg = latDeg / cosLat;
  return {
    minLat: Math.max(-90, lat - latDeg),
    maxLat: Math.min(90, lat + latDeg),
    minLng: Math.max(-180, lng - lonDeg),
    maxLng: Math.min(180, lng + lonDeg),
  };
};

/**
 * Reverse geocode (lat/lng → nearest features).
 *
 * Strategy:
 *   1. Bbox prefilter via `geom && ST_MakeEnvelope(...)` — index-aware
 *      (GiST), per-axis sized so it always covers the true sphere
 *      radius regardless of latitude (within the antimeridian caveat).
 *   2. Compute exact `ST_DistanceSphere` for each bbox candidate.
 *   3. Filter to true radius, sort by meters, apply LIMIT last so the
 *      result is correct (within the bbox) and deterministic.
 *
 * No KNN over-fetch hack: KNN sorts in planar degrees and can drop
 * valid east/west candidates at high latitudes. Bbox candidates are
 * usually a small enough set that exact sort is fast.
 *
 * Per-layer queries run sequentially. Promise.all here exhausts Bun's
 * default 10-connection pool under load and made things slower.
 */
export const reverse = async (
  input: ReverseInput,
): Promise<Result<{ features: Feature[]; total: number }>> => {
  const layers: FeatureLayer[] =
    (input.layers as FeatureLayer[] | undefined) ?? ["address", "locality"];
  const limit = input.limit ?? DEFAULT_LIMIT;
  const radiusKm = input.radius ?? DEFAULT_RADIUS_KM;
  const radiusM = radiusKm * 1000;
  const bbox = computeBbox(input.lat, input.lng, radiusM);

  const point = sql`ST_SetSRID(ST_MakePoint(${input.lng}, ${input.lat}), 4326)`;
  const envelope = sql`ST_MakeEnvelope(${bbox.minLng}, ${bbox.minLat}, ${bbox.maxLng}, ${bbox.maxLat}, 4326)`;

  const queryPlaces = async (): Promise<Hit[]> => sql<Hit[]>`
    WITH candidates AS (
      SELECT
        gid, name, latitude, longitude, country_code,
        ST_DistanceSphere(geom, ${point}) AS distance_m
      FROM geomark.places
      WHERE geom && ${envelope}
    )
    SELECT
      gid,
      'locality'::text AS layer,
      name,
      name AS label,
      latitude, longitude, country_code,
      distance_m
    FROM candidates
    WHERE distance_m <= ${radiusM}
    ORDER BY distance_m ASC
    LIMIT ${limit}
  `;

  const queryAddresses = async (): Promise<Hit[]> => sql<Hit[]>`
    WITH candidates AS (
      SELECT
        gid, house_number, street, label,
        latitude, longitude, country_code,
        ST_DistanceSphere(geom, ${point}) AS distance_m
      FROM geomark.addresses
      WHERE geom && ${envelope}
    )
    SELECT
      gid,
      'address'::text AS layer,
      COALESCE(NULLIF(TRIM(CONCAT_WS(' ', house_number, street)), ''), label) AS name,
      label,
      latitude, longitude, country_code,
      distance_m
    FROM candidates
    WHERE distance_m <= ${radiusM}
    ORDER BY distance_m ASC
    LIMIT ${limit}
  `;

  const all: Hit[] = [];
  if (layers.includes("locality")) all.push(...(await queryPlaces()));
  if (layers.includes("address")) all.push(...(await queryAddresses()));

  all.sort((a, b) => a.distance_m - b.distance_m);
  const top = all.slice(0, limit);

  // `score` here is endpoint-specific: a normalized closeness in [0, 1].
  // For reverse queries, consumers should rely on `distance_km` instead.
  const features: Feature[] = top.map((h) => ({
    gid: h.gid,
    layer: h.layer,
    name: h.name,
    label: h.label,
    latitude: h.latitude,
    longitude: h.longitude,
    country_code: h.country_code,
    score: 1 - Math.min(h.distance_m / radiusM, 1),
    distance_km: h.distance_m / 1000,
  }));

  return ok({ features, total: features.length });
};
