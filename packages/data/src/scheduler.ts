import { basename, join } from "node:path";
import { mkdir, readdir, stat, rm } from "node:fs/promises";
import { config } from "./config";
import { buildDataset, type PipelineConfig } from "./pipeline";
import type { DataMetricsRegistry } from "./metrics/registry";

/**
 * In-process scheduler. No Redis, no leader election, no cron expressions —
 * setTimeout chain that fires `buildDataset` every `REFRESH_INTERVAL_DAYS`
 * (default 30). On failure we back off and retry sooner. The container is
 * the unit of replication; if you want HA, run one builder pod and one or
 * more file-server pods sharing the volume.
 *
 * Trade-off vs cron: a long-running container that drifts will not fire
 * "exactly at 03:00 on the 1st"; it'll fire roughly every refresh interval
 * from the previous build. For monthly refresh of static-ish data, that's
 * close enough. If you want exact-time scheduling, run with `BUILD_ONCE=true`
 * and drive the container from the host's cron (or a Kubernetes CronJob).
 */

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

let stopped = false;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;

// Module-level metrics binding. Set by index.ts at boot. Calls are
// guarded with `metrics?.` so the scheduler works in tests / one-shot
// mode without a registry.
let metrics: DataMetricsRegistry | null = null;
export const bindMetrics = (m: DataMetricsRegistry): void => {
  metrics = m;
};

/**
 * Read the just-built manifest + bundle sizes from disk and feed them into
 * the metrics gauges. Called after every successful build. Failures here
 * don't abort the build — gauge updates are observability, not state.
 */
const recordBuildArtifacts = async (): Promise<void> => {
  if (!metrics) return;
  try {
    const manifest = await Bun.file(join(config.outputDir, "latest.json")).json();
    if (manifest?.version) {
      metrics.build.versionInfo.reset();
      metrics.build.versionInfo.labels({ version: String(manifest.version) }).set(1);
    }
    // Snapshot every *.csv.zst bundle's size — useful for catching
    // regressions (a sudden drop usually means a pipeline stage swallowed
    // an error). Per-filename labels are bounded by the small fixed set
    // of bundle files.
    const entries = await readdir(config.outputDir);
    for (const filename of entries) {
      if (!filename.endsWith(".csv.zst")) continue;
      const s = await stat(join(config.outputDir, filename));
      metrics.build.bundleSize.labels({ filename }).set(s.size);
    }
  } catch (err) {
    console.warn("[Geomark Data] failed to record build artifacts:", err);
  }
};

const stagingDir = (): string => join(config.outputDir, ".staging");

const filenameFromUrl = (url: string): string =>
  basename(new URL(url).pathname).replace(/\.zip$/, ".txt");

const pipelineConfig = (): PipelineConfig => ({
  geonamesCitiesUrl: config.geonamesCitiesUrl,
  geonamesPostalUrl: config.geonamesPostalUrl,
  geonamesCountryInfoUrl: config.geonamesCountryInfoUrl,
  openaddressesUrl: config.openaddressesUrl,
  citiesFilename: filenameFromUrl(config.geonamesCitiesUrl),
  postalFilename: filenameFromUrl(config.geonamesPostalUrl),
  ...(config.geonamesAliasesUrl
    ? {
        geonamesAliasesUrl: config.geonamesAliasesUrl,
        aliasesFilename: filenameFromUrl(config.geonamesAliasesUrl),
      }
    : {}),
});

const runBuild = async (opts: { freshStaging: boolean }): Promise<void> => {
  if (opts.freshStaging) {
    await rm(stagingDir(), { recursive: true, force: true });
  }
  await mkdir(stagingDir(), { recursive: true });
  await mkdir(config.outputDir, { recursive: true });

  const t0 = Date.now();
  try {
    await buildDataset(pipelineConfig(), {
      stagingDir: stagingDir(),
      outputDir: config.outputDir,
      log: (msg) => console.log(msg),
    });
    const elapsed = (Date.now() - t0) / 1000;
    metrics?.build.duration.observe(elapsed);
    metrics?.build.runs.labels({ result: "success" }).inc();
    metrics?.build.lastCompletedAt.set(Math.floor(Date.now() / 1000));
    await recordBuildArtifacts();
  } catch (err) {
    metrics?.build.runs.labels({ result: "error" }).inc();
    throw err;
  }
};

const refreshIntervalMs = (): number => config.refreshIntervalDays * ONE_DAY_MS;

const scheduleNext = (delayMs: number): void => {
  if (stopped) return;
  const minutes = Math.round(delayMs / 60_000);
  console.log(`[Geomark Data] next build in ${minutes} min`);
  pendingTimer = setTimeout(async () => {
    if (stopped) return;
    pendingTimer = null;
    try {
      await runBuild({ freshStaging: true });
      console.log(
        `[Geomark Data] build complete, next refresh in ${config.refreshIntervalDays} day(s)`,
      );
      scheduleNext(refreshIntervalMs());
    } catch (err) {
      console.error("[Geomark Data] build failed:", err);
      const retry = Math.min(ONE_HOUR_MS, refreshIntervalMs() / 24);
      scheduleNext(retry);
    }
  }, delayMs);
};

/**
 * Start the build/refresh loop. If no manifest exists, builds immediately;
 * otherwise schedules the first refresh after `REFRESH_INTERVAL_DAYS`.
 */
export const setupScheduler = async (): Promise<void> => {
  const hasManifest = await Bun.file(
    join(config.outputDir, "latest.json"),
  ).exists();

  if (!hasManifest) {
    console.log(
      "[Geomark Data] no manifest found, running initial build…",
    );
    try {
      await runBuild({ freshStaging: true });
      console.log("[Geomark Data] initial build complete");
    } catch (err) {
      console.error("[Geomark Data] initial build failed, will retry:", err);
      scheduleNext(ONE_HOUR_MS);
      return;
    }
  } else {
    console.log(
      `[Geomark Data] manifest exists, refreshing every ${config.refreshIntervalDays} day(s)`,
    );
    // Surface the existing artifacts in metrics so a restart doesn't blank
    // the gauges. lastCompletedAt is best-effort taken from latest.json's
    // mtime — close enough for a "freshness" alert.
    if (metrics) {
      try {
        const s = await stat(join(config.outputDir, "latest.json"));
        metrics.build.lastCompletedAt.set(Math.floor(s.mtimeMs / 1000));
      } catch { /* tolerated — gauges stay at 0 */ }
      await recordBuildArtifacts();
    }
  }
  scheduleNext(refreshIntervalMs());
};

export const stopScheduler = async (): Promise<void> => {
  stopped = true;
  if (pendingTimer !== null) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
};

/**
 * One-shot mode: run a single build and exit. Useful when an external
 * scheduler (cron, Kubernetes CronJob) drives the container.
 */
export const buildOnce = async (): Promise<void> => {
  await runBuild({ freshStaging: true });
};
