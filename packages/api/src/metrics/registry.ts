/**
 * Prometheus instrumentation surface for Geomark.
 *
 * Design notes (cribbed from filegate, adapted for Hono+Bun):
 *
 *   - Instance-based, not package-global. createRegistry() builds its own
 *     prom-client Registry and every metric handle. Tests get full
 *     isolation by constructing their own — no shared global state to
 *     reset between cases.
 *
 *   - Cardinality discipline. Labels are bounded sets only:
 *     `route` = matched route template ("/v1/place/{gid}", not the
 *     actual GID), `status_class` = "2xx"/"3xx"/.../"other" not the
 *     full code, `result` = a fixed enum. No labels for user IDs, IPs,
 *     query strings, gids — anything unbounded would blow up the TSDB.
 *
 *   - Always cheap to construct. The registry is built unconditionally
 *     so handles are valid from boot for the loader counters; only the
 *     /metrics endpoint and the request middleware are gated on
 *     `METRICS_ENABLED`. An unscraped registry costs a few KB.
 */

import {
  Counter,
  Gauge,
  Histogram,
  Registry as PromRegistry,
  collectDefaultMetrics,
} from "prom-client";

// API-latency buckets. Geomark serves ms-range searches; the long tail is
// dominated by the postal full-table scans and batch endpoints. Cap at 5s
// — anything slower is already a P1 incident, not a histogram concern.
const HTTP_DURATION_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5,
];

// Loader stages run for seconds to minutes (download + ingest of full
// world bundles). Wide span, log-spaced.
const LOADER_DURATION_BUCKETS = [
  0.5, 1, 5, 10, 30, 60, 300, 600, 1800,
];

export type MetricsRegistry = {
  readonly registry: PromRegistry;

  /** HTTP RED (Rate · Errors · Duration). */
  readonly http: {
    requests: Counter<"route" | "status_class">;
    duration: Histogram<"route">;
    inFlight: Gauge<string>;
  };

  /** Live dataset state — updated from the loader after each successful ingest. */
  readonly dataset: {
    places: Gauge<string>;
    addresses: Gauge<string>;
    postalCodes: Gauge<string>;
    aliases: Gauge<string>;
    /** Unix-epoch seconds. */
    loadedAt: Gauge<string>;
    /** Always 1; version carried in label so a rotation drops the prior series. */
    versionInfo: Gauge<"version">;
  };

  /** Loader/refresh bookkeeping. */
  readonly loader: {
    refreshes: Counter<"result">;
    duration: Histogram<"stage">;
  };

  readonly ratelimitRejected: Counter<string>;
  readonly authRejected: Counter<"reason">;

  /** Build info, value always 1, version+commit in labels. */
  readonly buildInfo: Gauge<"version" | "commit">;
};

type BuildInfo = {
  version: string;
  commit: string;
};

export const createRegistry = (build: BuildInfo = { version: "dev", commit: "none" }): MetricsRegistry => {
  const reg = new PromRegistry();

  // Standard process_* and nodejs_* runtime metrics. prom-client's defaults
  // include open FDs, RSS, heap, eventloop lag — exactly what you'd want to
  // alert on for a long-running Node-compat service.
  collectDefaultMetrics({ register: reg, prefix: "" });

  const httpRequests = new Counter({
    name: "geomark_http_requests_total",
    help: "Total HTTP requests, partitioned by route template and status class.",
    labelNames: ["route", "status_class"],
    registers: [reg],
  });
  const httpDuration = new Histogram({
    name: "geomark_http_request_duration_seconds",
    help: "HTTP request duration in seconds, partitioned by route template.",
    labelNames: ["route"],
    buckets: HTTP_DURATION_BUCKETS,
    registers: [reg],
  });
  const httpInFlight = new Gauge({
    name: "geomark_http_in_flight",
    help: "Number of HTTP requests currently being processed.",
    registers: [reg],
  });

  const datasetPlaces = new Gauge({
    name: "geomark_places_total",
    help: "Number of places in the loaded dataset.",
    registers: [reg],
  });
  const datasetAddresses = new Gauge({
    name: "geomark_addresses_total",
    help: "Number of addresses in the loaded dataset.",
    registers: [reg],
  });
  const datasetPostalCodes = new Gauge({
    name: "geomark_postal_codes_total",
    help: "Number of postal codes in the loaded dataset.",
    registers: [reg],
  });
  const datasetAliases = new Gauge({
    name: "geomark_aliases_total",
    help: "Number of place aliases (alternate names) in the loaded dataset.",
    registers: [reg],
  });
  const datasetLoadedAt = new Gauge({
    name: "geomark_dataset_loaded_at_seconds",
    help: "Unix timestamp of the most recent successful dataset load.",
    registers: [reg],
  });
  const datasetVersionInfo = new Gauge({
    name: "geomark_dataset_version_info",
    help: "Dataset version (value=1, version carried in label).",
    labelNames: ["version"],
    registers: [reg],
  });

  const loaderRefreshes = new Counter({
    name: "geomark_dataset_loads_total",
    help: "Loader refresh attempts, partitioned by result.",
    labelNames: ["result"], // success | error | skipped_unchanged
    registers: [reg],
  });
  const loaderDuration = new Histogram({
    name: "geomark_loader_duration_seconds",
    help: "Loader stage duration in seconds.",
    labelNames: ["stage"], // fetch_manifest | ingest | refresh
    buckets: LOADER_DURATION_BUCKETS,
    registers: [reg],
  });

  const ratelimitRejected = new Counter({
    name: "geomark_ratelimit_rejected_total",
    help: "Requests rejected by the per-IP rate limiter.",
    registers: [reg],
  });
  const authRejected = new Counter({
    name: "geomark_auth_rejected_total",
    help: "Requests rejected by bearer auth.",
    labelNames: ["reason"], // missing | malformed | invalid
    registers: [reg],
  });

  const buildInfo = new Gauge({
    name: "geomark_build_info",
    help: "Build metadata (value=1, version + commit in labels).",
    labelNames: ["version", "commit"],
    registers: [reg],
  });
  buildInfo.labels({ version: build.version, commit: build.commit }).set(1);

  return {
    registry: reg,
    http: { requests: httpRequests, duration: httpDuration, inFlight: httpInFlight },
    dataset: {
      places: datasetPlaces,
      addresses: datasetAddresses,
      postalCodes: datasetPostalCodes,
      aliases: datasetAliases,
      loadedAt: datasetLoadedAt,
      versionInfo: datasetVersionInfo,
    },
    loader: { refreshes: loaderRefreshes, duration: loaderDuration },
    ratelimitRejected,
    authRejected,
    buildInfo,
  };
};
