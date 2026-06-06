#!/usr/bin/env bun
/**
 * Throughput + latency speedtest against a running geomark API.
 *
 *   # spin up the integration stack first:
 *   KEEP_UP=1 bun run packages/api/scripts/integration-docker.ts
 *
 *   # then this:
 *   bun run packages/api/scripts/speedtest.ts
 *
 * Each scenario fires CONCURRENT virtual users hammering one endpoint
 * for DURATION_MS. Reports total reqs, RPS, and p50/p95/p99/max latency.
 */
const BASE = process.env.GEOMARK_BASE_URL ?? "http://localhost:14000";
const CONCURRENT = Number(process.env.SPEEDTEST_CONCURRENCY ?? "32");
const DURATION_MS = Number(process.env.SPEEDTEST_DURATION_MS ?? "10000");
const WARMUP_MS = 2000;
// Per-request timeout. Without it, a hung server tail-latencies the run
// and skews max ms past the configured duration.
const REQUEST_TIMEOUT_MS = 5_000;
// Anything past this gets logged so we can diagnose tail outliers.
const SLOW_REQUEST_MS = 1_000;

type Scenario = {
  name: string;
  next: () => RequestInfo | Request;
  init?: RequestInit;
};

const queries = [
  "berlin", "münchen", "munic", "hamburg", "köln", "frankfurt",
  "lübeck", "stuttgart", "düsseldorf", "ベルリン",
  "new york", "san francisco", "chicago",
];

const reverseSpots: [number, number][] = [
  [52.524, 13.410], // Berlin Mitte
  [48.137, 11.575], // Munich
  [53.551, 9.993], // Hamburg
  [40.714, -74.006], // NYC
  [37.775, -122.419], // SF
];

const placeGids = [
  "geonames:2950159", // Berlin
  "geonames:2867714", // Munich
  "geonames:5128581", // NYC
  "geonames:5391959", // SF
  "geonames:2911298", // Hamburg
];

const codes: [string, string][] = [
  ["iata", "MUC"],
  ["icao", "EDDB"],
  ["iata", "BER"],
];

let qi = 0;
let ri = 0;
let pi = 0;
let ci = 0;

const scenarios: Scenario[] = [
  {
    name: "GET /api/v1/search?q=...",
    next: () => `${BASE}/api/v1/search?q=${encodeURIComponent(queries[qi++ % queries.length]!)}&limit=10`,
  },
  {
    name: "GET /api/v1/search?q=... &prefer_lang=de",
    next: () => `${BASE}/api/v1/search?q=${encodeURIComponent(queries[qi++ % queries.length]!)}&prefer_lang=de&limit=10`,
  },
  {
    name: "GET /api/v1/reverse?lat=...&lng=...",
    next: () => {
      const [lat, lng] = reverseSpots[ri++ % reverseSpots.length]!;
      return `${BASE}/api/v1/reverse?lat=${lat}&lng=${lng}&limit=10&radius=10`;
    },
  },
  {
    name: "GET /api/v1/place/:gid (with aliases hydration)",
    next: () => `${BASE}/api/v1/place/${encodeURIComponent(placeGids[pi++ % placeGids.length]!)}`,
  },
  {
    name: "GET /api/v1/code/:kind/:value",
    next: () => {
      const [k, v] = codes[ci++ % codes.length]!;
      return `${BASE}/api/v1/code/${k}/${v}`;
    },
  },
  {
    name: "GET /api/v1/coverage",
    next: () => `${BASE}/api/v1/coverage`,
  },
  {
    name: "GET /api/v1/postal?code=10115",
    next: () => `${BASE}/api/v1/postal?code=10115`,
  },
];

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

const percentile = (sortedAsc: number[], p: number): number => {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.floor((p / 100) * sortedAsc.length),
  );
  return sortedAsc[idx]!;
};

const fmt = (n: number, d = 0): string =>
  n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });

const runScenario = async (s: Scenario): Promise<void> => {
  const latencies: number[] = [];
  let ok = 0;
  let fail = 0;
  let timeouts = 0;
  let bytes = 0;
  const slow: { url: string; ms: number; status: number | "timeout" | "error" }[] = [];
  const startedAt = performance.now();
  const stopAt = Date.now() + DURATION_MS;

  // Bypass the 60/min/IP rate-limit by generating a unique XFF per
  // request. The in-memory limiter keeps a bucket per key, so unique
  // keys = no collisions.
  let counter = 0;
  const worker = async (workerId: number): Promise<void> => {
    while (Date.now() < stopAt) {
      const url = s.next();
      const c = ++counter;
      const ip = `198.51.${(c >> 8) & 0xff}.${c & 0xff}`;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
      const t0 = performance.now();
      void workerId;
      try {
        const r = await fetch(url, {
          headers: {
            "X-Forwarded-For": ip,
            ...s.init?.headers,
          },
          signal: ctrl.signal,
          ...s.init,
        });
        const buf = await r.arrayBuffer();
        const dt = performance.now() - t0;
        latencies.push(dt);
        if (r.ok) ok++;
        else fail++;
        bytes += buf.byteLength;
        if (dt >= SLOW_REQUEST_MS) {
          slow.push({ url: String(url), ms: dt, status: r.status });
        }
      } catch (e) {
        const dt = performance.now() - t0;
        latencies.push(dt);
        fail++;
        const isTimeout = e instanceof Error && e.name === "AbortError";
        if (isTimeout) timeouts++;
        if (dt >= SLOW_REQUEST_MS) {
          slow.push({ url: String(url), ms: dt, status: isTimeout ? "timeout" : "error" });
        }
      } finally {
        clearTimeout(timer);
      }
    }
  };

  const workers = Array.from({ length: CONCURRENT }, (_, i) => worker(i));
  await Promise.all(workers);

  latencies.sort((a, b) => a - b);
  const elapsedMs = performance.now() - startedAt;
  const total = ok + fail;
  const rps = (total / elapsedMs) * 1000;
  console.log(
    `\n  ${s.name}\n` +
      `    total:    ${fmt(total)} (ok=${fmt(ok)}, fail=${fmt(fail)}, timeouts=${fmt(timeouts)})\n` +
      `    rps:      ${fmt(rps, 1)} (over ${fmt(elapsedMs / 1000, 1)}s actual)\n` +
      `    bytes:    ${fmt(bytes / 1024, 1)} KB total\n` +
      `    p50:      ${fmt(percentile(latencies, 50), 1)} ms\n` +
      `    p95:      ${fmt(percentile(latencies, 95), 1)} ms\n` +
      `    p99:      ${fmt(percentile(latencies, 99), 1)} ms\n` +
      `    max:      ${fmt(Math.max(...latencies), 1)} ms`,
  );
  if (slow.length > 0) {
    // Top 3 slowest as a diagnostic — tells you which URL pattern is
    // tail-latency-prone without flooding the output.
    slow.sort((a, b) => b.ms - a.ms);
    console.log(`    slow (≥${SLOW_REQUEST_MS}ms): ${slow.length}`);
    for (const s of slow.slice(0, 3)) {
      console.log(`      ${fmt(s.ms, 0)}ms [${s.status}] ${s.url.replace(BASE, "")}`);
    }
  }
};

const main = async (): Promise<void> => {
  // Sanity: server up?
  const probe = await fetch(`${BASE}/ready`).catch(() => null);
  if (!probe || probe.status !== 200) {
    console.error(`API not ready at ${BASE}. Spin it up via:`);
    console.error(`  KEEP_UP=1 bun run packages/api/scripts/integration-docker.ts`);
    process.exit(1);
  }

  console.log("=".repeat(70));
  console.log(`Geomark API speedtest — ${BASE}`);
  console.log(`  concurrency: ${CONCURRENT}`);
  console.log(`  duration:    ${DURATION_MS}ms per scenario`);
  console.log(`  warmup:      ${WARMUP_MS}ms (one warmup pass per scenario)`);
  console.log("=".repeat(70));

  for (const s of scenarios) {
    // Warmup: 2s of light load so the first scenario isn't penalised by
    // a cold connection pool.
    const warmStop = Date.now() + WARMUP_MS;
    while (Date.now() < warmStop) {
      await fetch(s.next() as RequestInfo, {
        headers: { "X-Forwarded-For": "198.51.100.1" },
      }).then((r) => r.arrayBuffer()).catch(() => null);
    }
    await sleep(200);
    await runScenario(s);
  }

  console.log("\n" + "=".repeat(70));
  console.log("✓ speedtest done");
};

await main();
process.exit(0);
export {};
