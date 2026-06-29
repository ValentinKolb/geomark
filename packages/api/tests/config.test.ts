import { describe, expect, test } from "bun:test";

const CONFIG_URL = new URL("../src/config.ts", import.meta.url).href;
const CONFIG_EVAL =
  `const { config } = await import(${JSON.stringify(CONFIG_URL)}); ` +
  "console.log(JSON.stringify({ " +
  "dataUrl: config.dataUrl, " +
  "loadOnce: config.loadOnce, " +
  "redisUrl: config.redisUrl ?? null, " +
  "randomCacheSeconds: config.randomCacheSeconds, " +
  "referenceCacheSeconds: config.referenceCacheSeconds " +
  "}));";

const readConfig = (overrides: Record<string, string | undefined>) => {
  const env: Record<string, string> = {
    ...process.env,
    DATABASE_URL: "postgres://geomark:geomark@localhost:5432/geomark",
    RATELIMIT_PER_MINUTE: "60",
    REFRESH_INTERVAL_HOURS: "6",
    TRUSTED_PROXY_HOPS: "1",
    METRICS_ENABLED: "true",
    METRICS_PATH: "/metrics",
  };
  delete env.DATA_URL;
  delete env.LOAD_ONCE;
  delete env.REDIS_URL;
  delete env.RANDOM_CACHE_SECONDS;
  delete env.REFERENCE_CACHE_SECONDS;
  delete env.API_KEY;
  delete env.METRICS_TOKEN;

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }

  const proc = Bun.spawnSync(["bun", "--eval", CONFIG_EVAL], {
    cwd: process.cwd(),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  if (proc.exitCode !== 0) {
    throw new Error(proc.stderr.toString());
  }
  return JSON.parse(proc.stdout.toString()) as {
    dataUrl: string;
    loadOnce: boolean;
    redisUrl: string | null;
    randomCacheSeconds: number;
    referenceCacheSeconds: number;
  };
};

describe("api config", () => {
  test("DATA_URL defaults to the data builder v1 namespace", () => {
    expect(readConfig({}).dataUrl).toBe("http://data:3000/v1");
  });

  test("LOAD_ONCE accepts the documented 1 value", () => {
    expect(readConfig({ LOAD_ONCE: "1" }).loadOnce).toBe(true);
  });

  test("LOAD_ONCE also accepts true for operator convenience", () => {
    expect(readConfig({ LOAD_ONCE: "true" }).loadOnce).toBe(true);
  });

  test("LOAD_ONCE is disabled when unset", () => {
    expect(readConfig({ LOAD_ONCE: undefined }).loadOnce).toBe(false);
  });

  test("REDIS_URL is optional", () => {
    expect(readConfig({}).redisUrl).toBeNull();
  });

  test("REDIS_URL accepts redis URLs", () => {
    expect(readConfig({ REDIS_URL: "redis://localhost:6379" }).redisUrl).toBe(
      "redis://localhost:6379",
    );
  });

  test("cache TTLs have production defaults", () => {
    const cfg = readConfig({});
    expect(cfg.randomCacheSeconds).toBe(10);
    expect(cfg.referenceCacheSeconds).toBe(300);
  });

  test("cache TTLs can be disabled with 0", () => {
    const cfg = readConfig({
      RANDOM_CACHE_SECONDS: "0",
      REFERENCE_CACHE_SECONDS: "0",
    });
    expect(cfg.randomCacheSeconds).toBe(0);
    expect(cfg.referenceCacheSeconds).toBe(0);
  });
});
