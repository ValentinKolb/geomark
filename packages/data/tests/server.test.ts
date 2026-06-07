import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../src/server";
import { createRegistry } from "../src/metrics/registry";

let dir: string;

const mkApp = (opts?: {
  metricsEnabled?: boolean;
  metricsToken?: string;
  metricsPath?: string;
}) =>
  createServer({
    outputDir: dir,
    metrics: createRegistry(),
    metricsEnabled: opts?.metricsEnabled ?? false,
    metricsToken: opts?.metricsToken,
    metricsPath: opts?.metricsPath,
  });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "geomark-server-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("server / GET /health", () => {
  test("returns 200 with status ok (root, unversioned)", async () => {
    const app = mkApp();
    const res = await app.fetch(new Request("http://x/health"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});

describe("server / GET /v1/latest.json", () => {
  test("returns 404 before the manifest exists", async () => {
    const app = mkApp();
    const res = await app.fetch(new Request("http://x/v1/latest.json"));
    expect(res.status).toBe(404);
  });

  test("serves the manifest with json content type and no-cache", async () => {
    await Bun.write(join(dir, "latest.json"), '{"v":"2026"}');
    const app = mkApp();

    const res = await app.fetch(new Request("http://x/v1/latest.json"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(await res.text()).toBe('{"v":"2026"}');
  });

  test("unversioned /latest.json is 404 (no legacy)", async () => {
    await Bun.write(join(dir, "latest.json"), '{"v":"2026"}');
    const app = mkApp();
    const res = await app.fetch(new Request("http://x/latest.json"));
    expect(res.status).toBe(404);
  });
});

describe("server / GET /v1/:filename", () => {
  test("streams a .csv.zst file with application/zstd and immutable cache", async () => {
    await Bun.write(join(dir, "places.csv.zst"), new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0x00]));
    const app = mkApp();

    const res = await app.fetch(new Request("http://x/v1/places.csv.zst"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zstd");
    expect(res.headers.get("cache-control")).toBe(
      "public, max-age=86400, immutable",
    );
    expect(res.headers.get("content-length")).toBe("5");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes[0]).toBe(0x28);
  });

  test("returns 404 for missing file", async () => {
    const app = mkApp();
    const res = await app.fetch(new Request("http://x/v1/missing.csv.zst"));
    expect(res.status).toBe(404);
  });

  test("rejects path traversal via dot-dot", async () => {
    await mkdir(join(dir, "..", "outside"), { recursive: true });
    await Bun.write(join(dir, "..", "outside", "secret.txt"), "secret");

    const app = mkApp();
    const res = await app.fetch(
      new Request("http://x/v1/" + encodeURIComponent("../outside/secret.txt")),
    );
    expect(res.status).toBe(400);
  });

  test("rejects filenames containing slashes", async () => {
    const app = mkApp();
    const res = await app.fetch(
      new Request("http://x/v1/" + encodeURIComponent("foo/bar.zst")),
    );
    expect(res.status).toBe(400);
  });

  test("rejects non-allowlisted filenames even if they exist in outputDir", async () => {
    await Bun.write(join(dir, "secret.txt"), "ssh-key");
    const app = mkApp();
    const res = await app.fetch(new Request("http://x/v1/secret.txt"));
    expect(res.status).toBe(400);
  });

  test("accepts only *.csv.zst in /v1/:filename", async () => {
    await Bun.write(join(dir, "addresses-de.csv.zst"), new Uint8Array([0x28, 0xb5, 0x2f, 0xfd]));
    const app = mkApp();
    const res = await app.fetch(new Request("http://x/v1/addresses-de.csv.zst"));
    expect(res.status).toBe(200);
  });
});

describe("server / metrics endpoint", () => {
  test("returns 404 when metrics disabled", async () => {
    const app = mkApp({ metricsEnabled: false });
    const res = await app.fetch(new Request("http://x/metrics"));
    expect(res.status).toBe(404);
  });

  test("open scrape when METRICS_TOKEN unset", async () => {
    const app = mkApp({ metricsEnabled: true });
    const res = await app.fetch(new Request("http://x/metrics"));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("# HELP geomark_data_build_info");
    expect(body).toContain("# HELP geomark_data_http_requests_total");
  });

  test("requires Bearer when METRICS_TOKEN set", async () => {
    const app = mkApp({ metricsEnabled: true, metricsToken: "scrape-secret" });

    const noHeader = await app.fetch(new Request("http://x/metrics"));
    expect(noHeader.status).toBe(401);

    const wrong = await app.fetch(
      new Request("http://x/metrics", {
        headers: { Authorization: "Bearer wrong" },
      }),
    );
    expect(wrong.status).toBe(401);

    const right = await app.fetch(
      new Request("http://x/metrics", {
        headers: { Authorization: "Bearer scrape-secret" },
      }),
    );
    expect(right.status).toBe(200);
  });

  test("custom metricsPath", async () => {
    const app = mkApp({ metricsEnabled: true, metricsPath: "/internal/metrics" });
    const standard = await app.fetch(new Request("http://x/metrics"));
    expect(standard.status).toBe(404);
    const custom = await app.fetch(new Request("http://x/internal/metrics"));
    expect(custom.status).toBe(200);
  });

  test("HTTP RED middleware records /v1/* traffic, skips ops endpoints", async () => {
    await Bun.write(join(dir, "places.csv.zst"), new Uint8Array([0x28, 0xb5, 0x2f, 0xfd]));
    await Bun.write(join(dir, "latest.json"), '{"v":"x"}');
    const app = mkApp({ metricsEnabled: true });

    await app.fetch(new Request("http://x/v1/latest.json"));
    await app.fetch(new Request("http://x/v1/places.csv.zst"));
    await app.fetch(new Request("http://x/health"));
    await app.fetch(new Request("http://x/metrics"));

    const scrape = await app.fetch(new Request("http://x/metrics")).then((r) => r.text());
    expect(scrape).toContain(
      'geomark_data_http_requests_total{route="/v1/latest.json",status_class="2xx"} 1',
    );
    expect(scrape).toContain(
      'geomark_data_http_requests_total{route="/v1/{filename}",status_class="2xx"} 1',
    );
    // Ops endpoints are NOT counted (middleware scoped to /v1/*).
    expect(scrape).not.toContain('route="/health"');
    expect(scrape).not.toContain('route="/metrics"');
    // Bytes-served credits the bundle filename.
    expect(scrape).toMatch(
      /geomark_data_bytes_served_total\{filename="places\.csv\.zst"\} 4/,
    );
  });
});
