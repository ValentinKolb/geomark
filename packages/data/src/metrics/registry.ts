/**
 * Prometheus instrumentation surface for the Geomark data builder.
 *
 * Mirrors the api package's pattern (instance-based, cardinality-bounded,
 * cheap to construct) but with a build-focused metric set: file-server RED
 * for the bundle downloads, build counters/durations for the periodic
 * pipeline, and bundle-size gauges so regressions in the build output
 * surface in scrapes.
 */

import {
  Counter,
  Gauge,
  Histogram,
  Registry as PromRegistry,
  collectDefaultMetrics,
} from "prom-client";

// File-server is mostly cheap GETs + the occasional multi-MB download.
// Buckets span ms-range manifest scrapes up to 60s long-poll-style downloads.
const HTTP_DURATION_BUCKETS = [
  0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30, 60,
];

// Build stages run anywhere from seconds (parse country info) to a half hour
// (full OpenAddresses ingest). Log-spaced to keep buckets useful at both
// ends without an explosion of series.
const BUILD_DURATION_BUCKETS = [
  1, 5, 15, 60, 300, 600, 1800, 3600, 7200,
];

export type DataMetricsRegistry = {
  readonly registry: PromRegistry;

  /** HTTP RED for the bundle file server. */
  readonly http: {
    requests: Counter<"route" | "status_class">;
    duration: Histogram<"route">;
    inFlight: Gauge<string>;
    bytesServed: Counter<"filename">;
  };

  /** Build pipeline state — updated by the scheduler. */
  readonly build: {
    runs: Counter<"result">; // success | error
    duration: Histogram<string>;
    /** Unix-epoch seconds of the last completed build. */
    lastCompletedAt: Gauge<string>;
    /** Bytes per published bundle file, set on each successful build. */
    bundleSize: Gauge<"filename">;
    /** Always 1; manifest dataset_version carried in label. */
    versionInfo: Gauge<"version">;
  };

  /** Build provenance, value=1, version+commit in labels. */
  readonly buildInfo: Gauge<"version" | "commit">;
};

type BuildInfo = {
  version: string;
  commit: string;
};

export const createRegistry = (
  build: BuildInfo = { version: "dev", commit: "none" },
): DataMetricsRegistry => {
  const reg = new PromRegistry();

  // Standard process_* / nodejs_* runtime metrics from prom-client defaults.
  collectDefaultMetrics({ register: reg, prefix: "" });

  const httpRequests = new Counter({
    name: "geomark_data_http_requests_total",
    help: "Bundle file-server requests, partitioned by route template and status class.",
    labelNames: ["route", "status_class"],
    registers: [reg],
  });
  const httpDuration = new Histogram({
    name: "geomark_data_http_request_duration_seconds",
    help: "Bundle file-server request duration in seconds, partitioned by route template.",
    labelNames: ["route"],
    buckets: HTTP_DURATION_BUCKETS,
    registers: [reg],
  });
  const httpInFlight = new Gauge({
    name: "geomark_data_http_in_flight",
    help: "Number of bundle file-server requests currently being processed.",
    registers: [reg],
  });
  const httpBytesServed = new Counter({
    name: "geomark_data_bytes_served_total",
    help: "Total bytes of bundle payloads served, by filename (egress tracking).",
    labelNames: ["filename"],
    registers: [reg],
  });

  const buildRuns = new Counter({
    name: "geomark_data_builds_total",
    help: "Build pipeline runs, partitioned by result.",
    labelNames: ["result"], // success | error
    registers: [reg],
  });
  const buildDuration = new Histogram({
    name: "geomark_data_build_duration_seconds",
    help: "End-to-end build pipeline duration in seconds (download + parse + compress + publish).",
    buckets: BUILD_DURATION_BUCKETS,
    registers: [reg],
  });
  const buildLastCompletedAt = new Gauge({
    name: "geomark_data_build_last_completed_at_seconds",
    help: "Unix timestamp of the most recent successful build. Alert if (now - this) exceeds the refresh interval × 2.",
    registers: [reg],
  });
  const buildBundleSize = new Gauge({
    name: "geomark_data_bundle_size_bytes",
    help: "Size in bytes of each published bundle file from the most recent successful build.",
    labelNames: ["filename"],
    registers: [reg],
  });
  const buildVersionInfo = new Gauge({
    name: "geomark_data_manifest_version_info",
    help: "Built manifest version (value=1, version in label, rotates cleanly).",
    labelNames: ["version"],
    registers: [reg],
  });

  const buildInfo = new Gauge({
    name: "geomark_data_build_info",
    help: "Builder binary metadata (value=1, version + commit in labels).",
    labelNames: ["version", "commit"],
    registers: [reg],
  });
  buildInfo.labels({ version: build.version, commit: build.commit }).set(1);

  return {
    registry: reg,
    http: {
      requests: httpRequests,
      duration: httpDuration,
      inFlight: httpInFlight,
      bytesServed: httpBytesServed,
    },
    build: {
      runs: buildRuns,
      duration: buildDuration,
      lastCompletedAt: buildLastCompletedAt,
      bundleSize: buildBundleSize,
      versionInfo: buildVersionInfo,
    },
    buildInfo,
  };
};
