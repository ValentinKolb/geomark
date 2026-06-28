import { describe, expect, test } from "bun:test";

const CONFIG_URL = new URL("../src/config.ts", import.meta.url).href;
const CONFIG_EVAL =
  `const { config } = await import(${JSON.stringify(CONFIG_URL)}); ` +
  "console.log(config.buildOnce ? 'true' : 'false');";

const readBuildOnce = (value: string | undefined): boolean => {
  const env: Record<string, string> = {
    ...process.env,
    GEONAMES_CITIES_URL: "https://example.com/cities500.zip",
    GEONAMES_POSTAL_URL: "https://example.com/allCountries.zip",
    GEONAMES_COUNTRY_INFO_URL: "https://example.com/countryInfo.txt",
    GEONAMES_ALIASES_URL: "",
    OPENADDRESSES_URL: "https://example.com/openaddresses.zip",
    OUTPUT_DIR: "/tmp/geomark-data-config-test",
    REFRESH_INTERVAL_DAYS: "30",
    METRICS_ENABLED: "true",
    METRICS_PATH: "/metrics",
  };
  if (value === undefined) {
    delete env.BUILD_ONCE;
  } else {
    env.BUILD_ONCE = value;
  }

  const proc = Bun.spawnSync(
    [
      "bun",
      "--eval",
      CONFIG_EVAL,
    ],
    {
      cwd: process.cwd(),
      env,
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  if (proc.exitCode !== 0) {
    throw new Error(proc.stderr.toString());
  }
  return proc.stdout.toString().trim() === "true";
};

describe("data config", () => {
  test("BUILD_ONCE accepts the documented 1 value", () => {
    expect(readBuildOnce("1")).toBe(true);
  });

  test("BUILD_ONCE also accepts true for operator convenience", () => {
    expect(readBuildOnce("true")).toBe(true);
  });

  test("BUILD_ONCE is disabled when unset", () => {
    expect(readBuildOnce(undefined)).toBe(false);
  });
});
