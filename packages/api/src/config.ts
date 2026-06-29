const required = (key: string): string => {
  const v = process.env[key];
  if (!v) throw new Error(`[Geomark] Missing required env: ${key}`);
  return v;
};

const requirePositiveInt = (key: string, raw: string): number => {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`[Geomark] ${key} must be a positive integer, got: ${raw}`);
  }
  return n;
};

const requireNonNegativeInt = (key: string, raw: string): number => {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(
      `[Geomark] ${key} must be a non-negative integer, got: ${raw}`,
    );
  }
  return n;
};

const requireUrl = (key: string, value: string): string => {
  try {
    new URL(value);
    return value;
  } catch {
    throw new Error(`[Geomark] ${key} is not a valid URL: ${value}`);
  }
};

const enabled = (raw: string | undefined): boolean =>
  raw === "1" || raw === "true";

const optionalUrl = (key: string, value: string | undefined): string | undefined =>
  value && value.length > 0 ? requireUrl(key, value) : undefined;

export const config = {
  databaseUrl: required("DATABASE_URL"),
  dataUrl: requireUrl(
    "DATA_URL",
    process.env.DATA_URL ?? "http://data:3000/v1",
  ),
  redisUrl: optionalUrl("REDIS_URL", process.env.REDIS_URL),
  apiKey: process.env.API_KEY,
  ratelimitPerMinute: requirePositiveInt(
    "RATELIMIT_PER_MINUTE",
    process.env.RATELIMIT_PER_MINUTE ?? "60",
  ),
  randomCacheSeconds: requireNonNegativeInt(
    "RANDOM_CACHE_SECONDS",
    process.env.RANDOM_CACHE_SECONDS ?? "10",
  ),
  referenceCacheSeconds: requireNonNegativeInt(
    "REFERENCE_CACHE_SECONDS",
    process.env.REFERENCE_CACHE_SECONDS ?? "300",
  ),
  refreshIntervalHours: requirePositiveInt(
    "REFRESH_INTERVAL_HOURS",
    process.env.REFRESH_INTERVAL_HOURS ?? "6",
  ),
  loadOnce: enabled(process.env.LOAD_ONCE),
  /**
   * Number of trusted reverse proxies in front of this server.
   *   0 = direct exposure → ignore X-Forwarded-For, use socket IP
   *   1 = one proxy (e.g. Traefik) → trust XFF.at(-1)
   *   N = N-deep proxy chain → trust XFF.at(-N)
   * The default `1` matches the typical compose/k8s+ingress deployment.
   */
  trustedProxyHops: requireNonNegativeInt(
    "TRUSTED_PROXY_HOPS",
    process.env.TRUSTED_PROXY_HOPS ?? "1",
  ),
  /**
   * Prometheus metrics endpoint. `enabled=false` skips middleware wiring
   * and the /metrics route entirely (zero per-request overhead). The
   * registry is always built so loader gauges stay valid.
   *
   * Auth is layered (see ./metrics/auth.ts): METRICS_TOKEN wins, falls
   * back to API_KEY when both are set, else open (trusted network).
   */
  metricsEnabled: (process.env.METRICS_ENABLED ?? "true") === "true",
  metricsToken: process.env.METRICS_TOKEN,
  metricsPath: process.env.METRICS_PATH ?? "/metrics",
  schema: "geomark",
  get requiresAuth() {
    return this.apiKey !== undefined && this.apiKey.length > 0;
  },
} as const;
