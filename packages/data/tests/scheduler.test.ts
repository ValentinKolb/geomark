import { describe, expect, test } from "bun:test";

const loadScheduler = async () => {
  process.env.OPENADDRESSES_URL = "https://example.com/openaddresses.zip";
  process.env.GEONAMES_CITIES_URL = "https://example.com/cities500.zip";
  process.env.GEONAMES_POSTAL_URL = "https://example.com/allCountries.zip";
  process.env.GEONAMES_COUNTRY_INFO_URL = "https://example.com/countryInfo.txt";
  return import("../src/scheduler");
};

describe("scheduler timer delays", () => {
  test("caps delays at the Node/Bun timer maximum", async () => {
    const { MAX_TIMEOUT_MS, nextTimeoutDelay } = await loadScheduler();
    const now = 1_000;
    expect(nextTimeoutDelay(now + MAX_TIMEOUT_MS + 60_000, now)).toBe(
      MAX_TIMEOUT_MS,
    );
  });

  test("returns the remaining delay when it is inside the timer maximum", async () => {
    const { nextTimeoutDelay } = await loadScheduler();
    const now = 1_000;
    expect(nextTimeoutDelay(now + 60_000, now)).toBe(60_000);
  });

  test("never returns a negative delay after the target time", async () => {
    const { nextTimeoutDelay } = await loadScheduler();
    expect(nextTimeoutDelay(1_000, 2_000)).toBe(0);
  });
});
