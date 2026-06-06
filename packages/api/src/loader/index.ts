import { sql } from "bun";
import { config } from "../config";
import { fetchManifest, type Manifest } from "./manifest";
import { ingestAll } from "./ingest";
import type { MetricsRegistry } from "../metrics/registry";

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_MINUTE_MS = 60 * 1000;

let stopped = false;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;
let consecutiveFailures = 0;
let metrics: MetricsRegistry | null = null;

const log = (msg: string): void => console.log(`[Geomark Loader] ${msg}`);

/**
 * Wire the loader to the metrics registry. Called once from the
 * executable entrypoint after createApp() builds the registry.
 * Pre-binding leaves the metric handles as null no-ops, so unit tests
 * that exercise the loader directly don't need a registry.
 */
export const bindMetrics = (m: MetricsRegistry): void => {
  metrics = m;
};

// ─── meta read ───────────────────────────────────────────────────────────────

type MetaRow = {
  dataset_version: string | null;
  manifest_sha256: string | null;
  loaded_at: Date | null;
};

const readMeta = async (): Promise<MetaRow> => {
  const rows = await sql<MetaRow[]>`
    SELECT dataset_version, manifest_sha256, loaded_at
    FROM geomark.meta
    WHERE id = TRUE
  `;
  return (
    rows[0] ?? { dataset_version: null, manifest_sha256: null, loaded_at: null }
  );
};

// ─── manifest fingerprint ────────────────────────────────────────────────────
//
// `version` is set by the data builder once per day; not enough to detect
// multiple same-day rebuilds. We hash a sorted concatenation of all
// per-file SHAs into a fingerprint and store it next to version. The
// dataset is treated as fresh only if BOTH version AND fingerprint match.

const fingerprint = async (m: Manifest): Promise<string> => {
  const parts = [
    m.version,
    m.files.places.sha256,
    m.files.postal_codes.sha256,
    m.files.countries.sha256,
    ...m.files.addresses
      .map((a) => `${a.country_code}:${a.sha256}`)
      .sort(),
    ...(m.files.aliases ? [`aliases:${m.files.aliases.sha256}`] : []),
  ];
  const data = new TextEncoder().encode(parts.join("|"));
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i]!.toString(16).padStart(2, "0");
  return hex;
};

// ─── one full refresh ────────────────────────────────────────────────────────

/**
 * Update dataset gauges from a freshly-ingested manifest + counts.
 * Resets the version-info label first so a version rotation drops the
 * prior series instead of emitting two parallel ones.
 */
const recordDatasetLoaded = (
  m: MetricsRegistry,
  manifest: Manifest,
  counts: {
    places: number;
    postal_codes: number;
    addresses: number;
    aliases: number;
  },
  loadedAt: Date,
): void => {
  m.dataset.places.set(counts.places);
  m.dataset.addresses.set(counts.addresses);
  m.dataset.postalCodes.set(counts.postal_codes);
  m.dataset.aliases.set(counts.aliases);
  m.dataset.loadedAt.set(Math.floor(loadedAt.getTime() / 1000));
  m.dataset.versionInfo.reset();
  m.dataset.versionInfo.labels({ version: manifest.version }).set(1);
};

/**
 * Read current dataset state from Postgres into the gauges. Used on the
 * skip-unchanged path so a process restart still surfaces the live counts
 * even though we didn't re-ingest. Cheap (a few SELECT COUNTs) but only
 * called from the refresh loop, not per request.
 */
const populateDatasetGaugesFromDb = async (
  m: MetricsRegistry,
  version: string,
  loadedAt: Date,
): Promise<void> => {
  const [row] = await sql<
    {
      places: number;
      addresses: number;
      postal: number;
      aliases: number;
    }[]
  >`
    SELECT
      (SELECT COUNT(*)::int FROM geomark.places)        AS places,
      (SELECT COUNT(*)::int FROM geomark.addresses)     AS addresses,
      (SELECT COUNT(*)::int FROM geomark.postal_codes)  AS postal,
      (SELECT COUNT(*)::int FROM geomark.place_aliases) AS aliases
  `;
  if (!row) return;
  m.dataset.places.set(row.places);
  m.dataset.addresses.set(row.addresses);
  m.dataset.postalCodes.set(row.postal);
  m.dataset.aliases.set(row.aliases);
  m.dataset.loadedAt.set(Math.floor(loadedAt.getTime() / 1000));
  m.dataset.versionInfo.reset();
  m.dataset.versionInfo.labels({ version }).set(1);
};

const refresh = async (): Promise<{ refreshed: boolean }> => {
  const refreshStart = Date.now();
  const manifest = await fetchManifest(config.dataUrl);
  const fp = await fingerprint(manifest);
  const meta = await readMeta();

  if (meta.dataset_version === manifest.version && meta.manifest_sha256 === fp) {
    log(`up to date (version ${manifest.version})`);
    metrics?.loader.refreshes.labels({ result: "skipped_unchanged" }).inc();
    if (metrics && meta.loaded_at) {
      await populateDatasetGaugesFromDb(metrics, manifest.version, meta.loaded_at);
    }
    return { refreshed: false };
  }

  log(
    `ingesting v${manifest.version} (was ${meta.dataset_version ?? "<empty>"}) — ${manifest.files.addresses.length} address shard(s)`,
  );
  const t0 = Date.now();

  const baseUrl = config.dataUrl.replace(/\/$/, "");
  const counts = await ingestAll(baseUrl, manifest, fp);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  log(
    `refresh complete in ${elapsed}s — ` +
      `places:${counts.places} postal:${counts.postal_codes} countries:${counts.countries} ` +
      `addresses:${counts.addresses} aliases:${counts.aliases}`,
  );

  if (metrics) {
    const loadedAt = new Date();
    recordDatasetLoaded(metrics, manifest, counts, loadedAt);
    metrics.loader.refreshes.labels({ result: "success" }).inc();
    metrics.loader.duration
      .labels({ stage: "ingest" })
      .observe((Date.now() - t0) / 1000);
    metrics.loader.duration
      .labels({ stage: "refresh" })
      .observe((Date.now() - refreshStart) / 1000);
  }
  return { refreshed: true };
};

// ─── scheduler ───────────────────────────────────────────────────────────────

const refreshIntervalMs = (): number => config.refreshIntervalHours * ONE_HOUR_MS;

const backoffMs = (failures: number): number => {
  const cap = refreshIntervalMs();
  const exp = ONE_MINUTE_MS * Math.pow(2, Math.min(failures, 6));
  return Math.min(exp, cap);
};

const scheduleNext = (delayMs: number): void => {
  if (stopped) return;
  const minutes = Math.round(delayMs / 60_000);
  log(`next check in ${minutes} min`);
  pendingTimer = setTimeout(async () => {
    if (stopped) return;
    pendingTimer = null;
    try {
      await refresh();
      consecutiveFailures = 0;
      scheduleNext(refreshIntervalMs());
    } catch (err) {
      consecutiveFailures++;
      metrics?.loader.refreshes.labels({ result: "error" }).inc();
      console.error(
        `[Geomark Loader] refresh failed (attempt ${consecutiveFailures}):`,
        err,
      );
      scheduleNext(backoffMs(consecutiveFailures));
    }
  }, delayMs);
};

/**
 * Start the loader: run an initial refresh, then schedule periodic checks.
 *
 * The HTTP server in index.ts MUST be started in parallel — `/health`
 * (liveness) needs to come up immediately. `/ready` returns 503 until the
 * meta table records a successful load.
 */
export const setupLoader = async (): Promise<void> => {
  log(`source: ${config.dataUrl}`);
  log(`refresh interval: ${config.refreshIntervalHours}h`);
  try {
    await refresh();
    consecutiveFailures = 0;
  } catch (err) {
    consecutiveFailures++;
    metrics?.loader.refreshes.labels({ result: "error" }).inc();
    console.error("[Geomark Loader] initial refresh failed:", err);
  }
  scheduleNext(
    consecutiveFailures > 0 ? backoffMs(consecutiveFailures) : refreshIntervalMs(),
  );
};

export const stopLoader = (): void => {
  stopped = true;
  if (pendingTimer !== null) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
};

/** One-shot mode: run a single refresh and exit. */
export const loadOnce = async (): Promise<void> => {
  await refresh();
};
