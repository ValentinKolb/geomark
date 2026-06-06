import type { z } from "zod";
import type {
  BatchRequestSchema,
  Feature,
} from "@geomark/shared";
import { ok, type Result } from "../lib/respond";
import { search } from "./search";
import { reverse } from "./reverse";

type BatchInput = z.infer<typeof BatchRequestSchema>;

/**
 * Run a batch of search and/or reverse queries. KISS: sequential loop, no
 * parallelism — Postgres connection pool is shared with other requests so
 * we don't want to fan out N concurrent queries.
 *
 * Per-entry errors collapse to an empty result for that slot rather than
 * failing the whole batch. The /batch endpoint is for ingest pipelines
 * that want resilience, not for interactive use.
 */
export const runBatch = async (
  input: BatchInput,
): Promise<Result<{ results: { features: Feature[]; total: number }[] }>> => {
  const out: { features: Feature[]; total: number }[] = [];
  for (const entry of input.entries) {
    try {
      if (entry.type === "search") {
        const r = await search({
          q: entry.q,
          layers: entry.layers,
          country: entry.country,
          proximity_lat: undefined,
          proximity_lng: undefined,
          bbox: undefined,
          limit: entry.limit,
        });
        out.push(r.ok ? r.data : { features: [], total: 0 });
      } else {
        const r = await reverse({
          lat: entry.lat,
          lng: entry.lng,
          layers: entry.layers,
          radius: entry.radius,
          limit: entry.limit,
        });
        out.push(r.ok ? r.data : { features: [], total: 0 });
      }
    } catch (e) {
      console.error("[batch] entry failed:", e);
      out.push({ features: [], total: 0 });
    }
  }
  return ok({ results: out });
};
