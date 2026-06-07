const required = (key: string): string => {
  const v = process.env[key];
  if (!v) throw new Error(`[Geomark Data] Missing required env: ${key}`);
  return v;
};

const requireUrlWithFilename = (key: string, value: string): string => {
  let pathname: string;
  try {
    pathname = new URL(value).pathname;
  } catch {
    throw new Error(`[Geomark Data] ${key} is not a valid URL: ${value}`);
  }
  const last = pathname.split("/").filter(Boolean).pop() ?? "";
  if (!last.includes(".")) {
    throw new Error(
      `[Geomark Data] ${key} must be a URL whose path ends in a filename ` +
        `(e.g. "https://example.com/data.zip"). Got: ${value}`,
    );
  }
  return value;
};

// Empty-string fallback (||, not ??) so a `KEY=""` env var (e.g. from
// docker-compose's `${VAR:-}` substitution when VAR is unset) falls
// through to the default URL instead of failing URL validation.
const cities = process.env.GEONAMES_CITIES_URL ||
  "https://download.geonames.org/export/dump/cities500.zip";
const postal = process.env.GEONAMES_POSTAL_URL ||
  "https://download.geonames.org/export/zip/allCountries.zip";
const countryInfo = process.env.GEONAMES_COUNTRY_INFO_URL ||
  "https://download.geonames.org/export/dump/countryInfo.txt";
// Optional. Disabled by default — alternateNamesV2 is ~250MB compressed
// and only useful when the API wants multilingual / IATA / wikilink
// metadata. Set this env var to enable.
const aliases = process.env.GEONAMES_ALIASES_URL || "";

const requirePositiveInt = (key: string, raw: string): number => {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(
      `[Geomark Data] ${key} must be a positive integer, got: ${raw}`,
    );
  }
  return n;
};

export const config = {
  outputDir: process.env.OUTPUT_DIR ?? "/data",
  refreshIntervalDays: requirePositiveInt(
    "REFRESH_INTERVAL_DAYS",
    process.env.REFRESH_INTERVAL_DAYS ?? "30",
  ),
  buildOnce: process.env.BUILD_ONCE === "true",
  geonamesCitiesUrl: requireUrlWithFilename("GEONAMES_CITIES_URL", cities),
  geonamesPostalUrl: requireUrlWithFilename("GEONAMES_POSTAL_URL", postal),
  geonamesCountryInfoUrl: requireUrlWithFilename(
    "GEONAMES_COUNTRY_INFO_URL",
    countryInfo,
  ),
  openaddressesUrl: requireUrlWithFilename(
    "OPENADDRESSES_URL",
    required("OPENADDRESSES_URL"),
  ),
  /** Empty string when not configured. Validated lazily by the pipeline. */
  geonamesAliasesUrl: aliases
    ? requireUrlWithFilename("GEONAMES_ALIASES_URL", aliases)
    : "",
  /**
   * Gate the /metrics scrape endpoint and the HTTP RED middleware. The
   * registry itself is always built so build counters stay valid from boot
   * (cheap when unscraped).
   */
  metricsEnabled: (process.env.METRICS_ENABLED ?? "true") !== "false",
  /** Bearer token for /metrics. Empty / unset → open mode. */
  metricsToken: process.env.METRICS_TOKEN || undefined,
  /** Override the scrape path. Defaults to "/metrics" (root). */
  metricsPath: process.env.METRICS_PATH ?? "/metrics",
} as const;
