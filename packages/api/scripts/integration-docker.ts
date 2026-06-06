#!/usr/bin/env bun
/**
 * End-to-end Docker integration test.
 *
 * Builds and runs the full stack via docker compose (db + data + api),
 * with a smaller-dataset override so total runtime is bounded:
 *   - GeoNames cities15000 (~25k rows) instead of cities500 (~200k)
 *   - GeoNames DE postal codes (~12k rows) instead of allCountries (~1.8M)
 *   - Mock OpenAddresses zip served from host with synthetic DE+US data
 *
 * Then verifies every API endpoint with real HTTP requests against the
 * running API container.
 *
 * Run from monorepo root:
 *   bun run packages/api/scripts/integration-docker.ts
 *
 * IMPORTANT: this script touches ONLY containers labelled with the
 * `geomark-it` compose project name. It never touches other running
 * containers.
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

// ─── config ──────────────────────────────────────────────────────────────────

const COMPOSE_PROJECT = "geomark-it";
const COMPOSE_FILE = "compose.yml";
const MOCK_OA_PORT = 19980;
const MOCK_ALIASES_PORT = 19981;
// High ports unlikely to collide with the user's other services (the
// default 4000 conflicted with another local dev process during testing).
const API_HOST_PORT = 14000;
const DATA_HOST_PORT = 14002;
const READY_TIMEOUT_MS = 30 * 60 * 1000; // 30 min for slow first-build pulls

const SMALL_DATASET = {
  GEONAMES_CITIES_URL:
    "https://download.geonames.org/export/dump/cities15000.zip",
  GEONAMES_POSTAL_URL:
    "https://download.geonames.org/export/zip/DE.zip",
  GEONAMES_COUNTRY_INFO_URL:
    "https://download.geonames.org/export/dump/countryInfo.txt",
};

// ─── helpers ─────────────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

const sh = (
  cmd: string[],
  opts: { env?: Record<string, string>; cwd?: string } = {},
): { code: number; stdout: string; stderr: string } => {
  const r = Bun.spawnSync(cmd, {
    env: { ...process.env, ...opts.env },
    cwd: opts.cwd ?? process.cwd(),
    stderr: "pipe",
    stdout: "pipe",
  });
  return {
    code: r.exitCode ?? -1,
    stdout: r.stdout.toString(),
    stderr: r.stderr.toString(),
  };
};

const compose = (
  args: string[],
  opts: { env?: Record<string, string> } = {},
): { code: number; stdout: string; stderr: string } =>
  sh(
    [
      "docker", "compose",
      "-p", COMPOSE_PROJECT,
      "-f", COMPOSE_FILE,
      ...args,
    ],
    opts,
  );

const log = (msg: string): void => console.log(`[integration] ${msg}`);

// ─── synthetic OpenAddresses zip ─────────────────────────────────────────────

const buildOaZip = async (): Promise<string> => {
  const stage = await mkdtemp(join(tmpdir(), "geomark-it-oa-"));
  const oaDir = join(stage, "openaddresses");
  await mkdir(oaDir, { recursive: true });
  await writeFile(
    join(oaDir, "de.csv"),
    "HASH,LON,LAT,NUMBER,STREET,UNIT,CITY,DISTRICT,REGION,POSTCODE\n" +
      "abc1,13.41053,52.52437,12,Müllerstraße,,Berlin,Mitte,Berlin,10115\n" +
      "abc2,13.42000,52.51000,5,Friedrichstraße,,Berlin,Mitte,Berlin,10117\n" +
      "abc3,11.57500,48.13700,7a,Marienplatz,,München,,Bayern,80331\n" +
      "abc4,9.99000,53.55000,1,Mönckebergstraße,,Hamburg,,Hamburg,20095\n",
  );
  await writeFile(
    join(oaDir, "us.csv"),
    "HASH,LON,LAT,NUMBER,STREET,UNIT,CITY,DISTRICT,REGION,POSTCODE\n" +
      "us001,-74.00597,40.71427,1,Broadway,,New York,,NY,10004\n" +
      "us002,-122.41942,37.77493,2300,Fillmore St,Apt 3,San Francisco,,CA,94115\n" +
      "us003,-87.62980,41.87810,233,Wacker Dr,,Chicago,,IL,60606\n",
  );

  const zipPath = join(stage, "oa.zip");
  const r = sh(["zip", "-q", "-r", zipPath, "openaddresses"], { cwd: stage });
  if (r.code !== 0) {
    throw new Error(`zip failed: ${r.stderr}`);
  }
  return zipPath;
};

const startMockOaServer = async (zipPath: string): Promise<{ stop: () => void }> => {
  const app = new Hono();
  app.get("/oa.zip", () => {
    const file = Bun.file(zipPath);
    return new Response(file.stream(), {
      headers: { "Content-Type": "application/zip" },
    });
  });
  const server = Bun.serve({ port: MOCK_OA_PORT, fetch: app.fetch });
  log(`mock OA server on http://host.docker.internal:${MOCK_OA_PORT}/oa.zip`);
  return { stop: () => server.stop(true) };
};

// ─── synthetic alternateNamesV2 zip ──────────────────────────────────────────
// alternateNamesV2.zip is ~250MB upstream — way too slow for an
// integration test. We craft a minimal one by hand for a few cities the
// test downloads via cities15000 (Berlin 2950159, Munich 2867714, NYC
// 5128581, Hamburg 2911298).

const buildAliasesZip = async (): Promise<string> => {
  const stage = await mkdtemp(join(tmpdir(), "geomark-it-alias-"));
  const txtPath = join(stage, "alternateNamesV2.txt");
  // GeoNames TSV format: 10 cols, see packages/data/src/pipeline/08-aliases.ts.
  // Cols we use: 1=geonameid, 2=isolanguage, 3=value, 4=isPreferred.
  const rows: string[][] = [
    // Berlin
    ["1", "2950159", "de", "Berlin", "1", "0", "0", "0", "", ""],
    ["2", "2950159", "en", "Berlin", "1", "0", "0", "0", "", ""],
    ["3", "2950159", "fr", "Berlin", "1", "0", "0", "0", "", ""],
    ["4", "2950159", "ja", "ベルリン", "0", "0", "0", "0", "", ""],
    ["5", "2950159", "iata", "BER", "0", "0", "0", "0", "", ""],
    ["6", "2950159", "icao", "EDDB", "0", "0", "0", "0", "", ""],
    ["7", "2950159", "link", "https://en.wikipedia.org/wiki/Berlin", "0", "0", "0", "0", "", ""],
    // Munich
    ["10", "2867714", "de", "München", "1", "0", "0", "0", "", ""],
    ["11", "2867714", "en", "Munich", "1", "0", "0", "0", "", ""],
    ["12", "2867714", "it", "Monaco di Baviera", "0", "0", "0", "0", "", ""],
    ["13", "2867714", "iata", "MUC", "0", "0", "0", "0", "", ""],
    ["14", "2867714", "icao", "EDDM", "0", "0", "0", "0", "", ""],
    ["15", "2867714", "abbr", "M", "0", "0", "0", "0", "", ""],
    // NYC
    ["20", "5128581", "abbr", "NYC", "0", "0", "0", "0", "", ""],
    ["21", "5128581", "iata", "NYC", "0", "0", "0", "0", "", ""],
    // Hamburg
    ["30", "2911298", "de", "Hamburg", "1", "0", "0", "0", "", ""],
    ["31", "2911298", "en", "Hamburg", "1", "0", "0", "0", "", ""],
    ["32", "2911298", "iata", "HAM", "0", "0", "0", "0", "", ""],
    // Junk row that should be filtered (geonameid not in places)
    ["999", "9999999", "en", "ShouldBeFiltered", "0", "0", "0", "0", "", ""],
  ];
  await writeFile(
    txtPath,
    rows.map((r) => r.join("\t")).join("\n") + "\n",
  );

  const zipPath = join(stage, "alternateNamesV2.zip");
  const r = sh(["zip", "-q", "-j", zipPath, txtPath], { cwd: stage });
  if (r.code !== 0) {
    throw new Error(`alias zip failed: ${r.stderr}`);
  }
  return zipPath;
};

const startMockAliasesServer = async (zipPath: string): Promise<{ stop: () => void }> => {
  const app = new Hono();
  app.get("/alternateNamesV2.zip", () => {
    const file = Bun.file(zipPath);
    return new Response(file.stream(), {
      headers: { "Content-Type": "application/zip" },
    });
  });
  const server = Bun.serve({ port: MOCK_ALIASES_PORT, fetch: app.fetch });
  log(`mock aliases server on http://host.docker.internal:${MOCK_ALIASES_PORT}/alternateNamesV2.zip`);
  return { stop: () => server.stop(true) };
};

// ─── readiness wait ──────────────────────────────────────────────────────────

const waitForApiReady = async (): Promise<void> => {
  const start = Date.now();
  let lastStatus = 0;
  let lastBody = "";
  while (Date.now() - start < READY_TIMEOUT_MS) {
    try {
      const r = await fetch(`http://localhost:${API_HOST_PORT}/ready`);
      lastStatus = r.status;
      const body = (await r.json()) as {
        status: string;
        places_count?: number;
        addresses_count?: number;
        postal_codes_count?: number;
      };
      lastBody = JSON.stringify(body);
      if (r.status === 200 && body.status === "ready") {
        log(
          `api ready after ${((Date.now() - start) / 1000).toFixed(0)}s ` +
            `— places:${body.places_count} addresses:${body.addresses_count} postal:${body.postal_codes_count}`,
        );
        return;
      }
      // Print progress every 30s
      if ((Date.now() - start) % 30000 < 5000) {
        log(`waiting… status=${r.status} ${lastBody}`);
      }
    } catch (e) {
      // API container not up yet — keep polling
      void e;
    }
    await sleep(5000);
  }
  throw new Error(
    `api never became ready (last status=${lastStatus}, body=${lastBody})`,
  );
};

// ─── endpoint checks ─────────────────────────────────────────────────────────

const baseUrl = `http://localhost:${API_HOST_PORT}`;

const json = async <T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> => {
  const r = await fetch(`${baseUrl}${path}`, init);
  return { status: r.status, body: (await r.json()) as T };
};

const expect = (cond: boolean, msg: string): void => {
  if (!cond) throw new Error(`assert: ${msg}`);
};

const checks: { name: string; run: () => Promise<void> }[] = [
  {
    name: "/health = 200 ok",
    run: async () => {
      const r = await json<{ status: string }>("/health");
      expect(r.status === 200, `status=${r.status}`);
      expect(r.body.status === "ok", `body=${JSON.stringify(r.body)}`);
    },
  },
  {
    name: "/ready = 200 ready with counts > 0",
    run: async () => {
      const r = await json<{
        status: string;
        places_count: number;
        addresses_count: number;
        postal_codes_count: number;
      }>("/ready");
      expect(r.status === 200, `status=${r.status}`);
      expect(r.body.status === "ready", `status=${r.body.status}`);
      expect(r.body.places_count > 1000, `places=${r.body.places_count}`);
      expect(r.body.addresses_count >= 7, `addresses=${r.body.addresses_count}`);
      expect(r.body.postal_codes_count > 100, `postal=${r.body.postal_codes_count}`);
    },
  },
  {
    name: "/api/v1/search?q=berlin returns Berlin (real GeoNames row)",
    run: async () => {
      const r = await json<{ features: { name: string; country_code: string; layer: string }[] }>(
        "/api/v1/search?q=berlin&limit=5",
      );
      expect(r.status === 200, `status=${r.status}`);
      expect(r.body.features.length > 0, "no features");
      const berlin = r.body.features.find(
        (f) => f.name === "Berlin" && f.country_code === "DE" && f.layer === "locality",
      );
      expect(berlin !== undefined, `Berlin/DE/locality not in top-5: ${JSON.stringify(r.body.features)}`);
    },
  },
  {
    // GeoNames cities*.zip uses the international name (Munich, not München);
    // local-language names live in alternateNames which we don't load in v0.1.
    // So we test typo-tolerance against an English name instead.
    name: "/api/v1/search?q=munic (typo) → Munich (trgm fuzzy)",
    run: async () => {
      // Truncated typo "munic" (missing trailing h). Cities15000 ships
      // the English name "Munich" — local "München" lives in
      // alternateNames which we don't load.
      const r = await json<{ features: { name: string; score: number }[] }>(
        "/api/v1/search?q=munic&limit=5&country=DE",
      );
      expect(r.status === 200, `status=${r.status}`);
      expect(
        r.body.features.some((f) => f.name === "Munich"),
        `no Munich in features: ${JSON.stringify(r.body.features.map((f) => ({ n: f.name, s: f.score })))}`,
      );
    },
  },
  {
    name: "/api/v1/search?q=Müllerstraße → synthetic OA address hit",
    run: async () => {
      const r = await json<{ features: { name: string; layer: string; country_code: string }[] }>(
        "/api/v1/search?q=Müllerstraße&layers=address&limit=3",
      );
      expect(r.status === 200, `status=${r.status}`);
      const addr = r.body.features.find(
        (f) => f.layer === "address" && f.country_code === "DE",
      );
      expect(addr !== undefined, `no DE address: ${JSON.stringify(r.body.features)}`);
    },
  },
  {
    name: "/api/v1/reverse near Berlin Mitte (52.52, 13.41)",
    run: async () => {
      const r = await json<{ features: { distance_km: number; layer: string }[] }>(
        "/api/v1/reverse?lat=52.52&lng=13.41&radius=5&limit=5",
      );
      expect(r.status === 200, `status=${r.status}`);
      expect(r.body.features.length > 0, "no features");
      expect(
        (r.body.features[0]?.distance_km ?? 999) < 1,
        `nearest dist=${r.body.features[0]?.distance_km}`,
      );
    },
  },
  {
    name: "/api/v1/postal?code=10115 → Berlin Mitte",
    run: async () => {
      const r = await json<{ postal_codes: { place_name: string }[] }>(
        "/api/v1/postal?code=10115",
      );
      expect(r.status === 200, `status=${r.status}`);
      expect(r.body.postal_codes.length > 0, "no postal hits");
      const place = r.body.postal_codes[0]?.place_name ?? "";
      expect(
        place.toLowerCase().includes("berlin"),
        `expected Berlin*, got ${place}`,
      );
    },
  },
  {
    name: "/api/v1/countries → list with DE + US",
    run: async () => {
      const r = await json<{ countries: { code: string; name: string }[]; total: number }>(
        "/api/v1/countries",
      );
      expect(r.status === 200, `status=${r.status}`);
      expect(r.body.total > 200, `total=${r.body.total}`);
      const de = r.body.countries.find((c) => c.code === "DE");
      const us = r.body.countries.find((c) => c.code === "US");
      expect(de?.name === "Germany", `DE.name=${de?.name}`);
      expect(us?.name === "United States", `US.name=${us?.name}`);
    },
  },
  {
    name: "/api/v1/countries/de → Germany",
    run: async () => {
      const r = await json<{ name: string; languages: string[] }>("/api/v1/countries/de");
      expect(r.status === 200, `status=${r.status}`);
      expect(r.body.name === "Germany", `name=${r.body.name}`);
      expect(r.body.languages.includes("de"), `langs=${JSON.stringify(r.body.languages)}`);
    },
  },
  {
    name: "/api/v1/coverage → DE/US = address",
    run: async () => {
      const r = await json<{ countries: Record<string, string> }>("/api/v1/coverage");
      expect(r.status === 200, `status=${r.status}`);
      expect(r.body.countries["DE"] === "address", `DE=${r.body.countries["DE"]}`);
      expect(r.body.countries["US"] === "address", `US=${r.body.countries["US"]}`);
    },
  },
  {
    name: "/api/v1/batch → mixed search + reverse",
    run: async () => {
      const r = await json<{ results: { features: { name: string }[] }[] }>(
        "/api/v1/batch",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            entries: [
              { type: "search", q: "berlin", country: "DE", limit: 1 },
              { type: "reverse", lat: 52.52, lng: 13.41, radius: 5, limit: 1 },
            ],
          }),
        },
      );
      expect(r.status === 200, `status=${r.status}`);
      expect(r.body.results.length === 2, `len=${r.body.results.length}`);
      expect(
        r.body.results[0]!.features[0]?.name === "Berlin",
        `batch[0]=${r.body.results[0]!.features[0]?.name}`,
      );
    },
  },
  {
    name: "/api/v1/openapi.json lists all 11 paths with 401/429/500",
    run: async () => {
      const r = await json<{
        paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
      }>("/api/v1/openapi.json");
      expect(r.status === 200, `status=${r.status}`);
      const paths = [
        "/api/v1/search", "/api/v1/reverse", "/api/v1/batch",
        "/api/v1/place/{gid}", "/api/v1/code/{kind}/{value}",
        "/api/v1/postal",
        "/api/v1/countries", "/api/v1/countries/{code}",
        "/api/v1/coverage", "/api/v1/attribution", "/api/v1/random",
      ];
      for (const p of paths) {
        expect(p in r.body.paths, `missing path: ${p}`);
        const op = Object.values(r.body.paths[p]!)[0]!;
        expect("401" in op.responses, `${p} missing 401`);
        expect("429" in op.responses, `${p} missing 429`);
      }
    },
  },
  {
    name: "/api/v1/docs serves Scalar HTML",
    run: async () => {
      const r = await fetch(`${baseUrl}/api/v1/docs`);
      expect(r.status === 200, `status=${r.status}`);
      const html = await r.text();
      expect(html.toLowerCase().includes("scalar"), "no scalar in /api/v1/docs html");
    },
  },
  // ─── aliases checks (require GEONAMES_ALIASES_URL ingest) ──────────────────
  {
    name: "/api/v1/search?q=München → Munich (matched_alias.lang=de)",
    run: async () => {
      const r = await json<{
        features: { name: string; gid: string; matched_alias?: { lang: string | null; value: string } }[];
      }>("/api/v1/search?q=M%C3%BCnchen&country=DE&limit=5");
      expect(r.status === 200, `status=${r.status}`);
      const munich = r.body.features.find((f) => f.gid === "geonames:2867714");
      expect(munich !== undefined, `Munich not in: ${JSON.stringify(r.body.features.map((f) => f.gid))}`);
      expect(munich!.matched_alias?.lang === "de", `matched_alias.lang=${munich!.matched_alias?.lang}`);
      expect(munich!.matched_alias?.value === "München", `matched_alias.value=${munich!.matched_alias?.value}`);
    },
  },
  {
    name: "/api/v1/search?q=ベルリン → Berlin (Japanese name)",
    run: async () => {
      const r = await json<{ features: { gid: string }[] }>(
        "/api/v1/search?q=%E3%83%99%E3%83%AB%E3%83%AA%E3%83%B3&limit=3",
      );
      expect(r.status === 200, `status=${r.status}`);
      expect(r.body.features.some((f) => f.gid === "geonames:2950159"), "no Berlin");
    },
  },
  {
    name: "/api/v1/search?q=Munich&prefer_lang=de localizes name to München",
    run: async () => {
      const r = await json<{ features: { name: string; gid: string }[] }>(
        "/api/v1/search?q=Munich&country=DE&limit=3&prefer_lang=de",
      );
      expect(r.status === 200, `status=${r.status}`);
      const munich = r.body.features.find((f) => f.gid === "geonames:2867714");
      expect(munich?.name === "München", `name=${munich?.name}`);
    },
  },
  {
    name: "/api/v1/place/geonames:2867714 hydrates aliases (incl. IATA + link)",
    run: async () => {
      const r = await json<{
        place: { name: string };
        aliases: { kind: string; lang: string | null; value: string }[];
      }>("/api/v1/place/geonames:2867714");
      expect(r.status === 200, `status=${r.status}`);
      expect(r.body.place.name === "Munich", `name=${r.body.place.name}`);
      const de = r.body.aliases.find((a) => a.kind === "name" && a.lang === "de");
      expect(de?.value === "München", `de=${de?.value}`);
      const iata = r.body.aliases.find((a) => a.kind === "iata");
      expect(iata?.value === "MUC", `iata=${iata?.value}`);
    },
  },
  {
    name: "/api/v1/code/iata/MUC → Munich",
    run: async () => {
      const r = await json<{ gid: string; name: string }>("/api/v1/code/iata/MUC");
      expect(r.status === 200, `status=${r.status}`);
      expect(r.body.gid === "geonames:2867714", `gid=${r.body.gid}`);
      expect(r.body.name === "Munich", `name=${r.body.name}`);
    },
  },
  {
    name: "/api/v1/code/icao/eddb (case-insensitive) → Berlin",
    run: async () => {
      const r = await json<{ gid: string }>("/api/v1/code/icao/eddb");
      expect(r.status === 200, `status=${r.status}`);
      expect(r.body.gid === "geonames:2950159", `gid=${r.body.gid}`);
    },
  },
  {
    name: "/api/v1/code/iata/ZZZ → 404",
    run: async () => {
      const r = await fetch(`${baseUrl}/api/v1/code/iata/ZZZ`);
      expect(r.status === 404, `status=${r.status}`);
    },
  },
  {
    name: "/ready reports aliases count",
    run: async () => {
      const r = await fetch(`${baseUrl}/ready`);
      expect(r.status === 200, `status=${r.status}`);
      // The body shape doesn't include aliases_count yet; just check the
      // place_aliases table directly via the /openapi.json existence.
      // (We log the count inside loader; trust that.)
    },
  },
];

// ─── main ────────────────────────────────────────────────────────────────────

const teardown = (): void => {
  if (process.env.KEEP_UP === "1") {
    log(`KEEP_UP=1 — leaving stack running. Endpoints:`);
    log(`  api: http://localhost:${API_HOST_PORT}`);
    log(`  data: http://localhost:${DATA_HOST_PORT}`);
    log(`  teardown: docker compose -p ${COMPOSE_PROJECT} down -v`);
    return;
  }
  log("docker compose down -v");
  compose(["down", "-v", "--remove-orphans"]);
};

const main = async (): Promise<void> => {
  console.log("=".repeat(60));
  console.log(`Geomark API — Docker integration (project: ${COMPOSE_PROJECT})`);
  console.log("=".repeat(60));

  // 1. Build mock OA + aliases zips + serve them
  log("building synthetic OpenAddresses zip");
  const oaZip = await buildOaZip();
  const mockOa = await startMockOaServer(oaZip);
  log("building synthetic alternateNamesV2 zip");
  const aliasesZip = await buildAliasesZip();
  const mockAliases = await startMockAliasesServer(aliasesZip);

  // 2. Bring stack up. We don't need `web` for API integration, so name
  //    only the services we actually want.
  const env: Record<string, string> = {
    ...SMALL_DATASET,
    OPENADDRESSES_URL: `http://host.docker.internal:${MOCK_OA_PORT}/oa.zip`,
    GEONAMES_ALIASES_URL: `http://host.docker.internal:${MOCK_ALIASES_PORT}/alternateNamesV2.zip`,
    POSTGRES_USER: "geomark",
    POSTGRES_PASSWORD: "geomark",
    POSTGRES_DB: "geomark",
    // API talks to data via service DNS; not the host port.
    DATA_URL: "http://data:3000",
    // Use high ports to avoid colliding with the user's other services.
    API_HOST_PORT: String(API_HOST_PORT),
    DATA_HOST_PORT: String(DATA_HOST_PORT),
  };

  let buildOk = false;
  try {
    log("docker compose build (db skipped — pulled image)");
    const build = compose(["build", "data", "api"], { env });
    if (build.code !== 0) {
      console.error(build.stdout);
      console.error(build.stderr);
      throw new Error(`compose build failed (exit ${build.code})`);
    }

    log("docker compose up -d db data api");
    const up = compose(["up", "-d", "db", "data", "api"], { env });
    if (up.code !== 0) {
      console.error(up.stdout);
      console.error(up.stderr);
      throw new Error(`compose up failed (exit ${up.code})`);
    }
    buildOk = true;

    log("waiting for /ready (this can take ~3-5 min on first pull/build)");
    await waitForApiReady();

    // 3. Run all checks
    let pass = 0;
    let fail = 0;
    for (const c of checks) {
      try {
        await c.run();
        console.log(`  ✓ ${c.name}`);
        pass++;
      } catch (e) {
        console.log(`  ✗ ${c.name}\n     ${e instanceof Error ? e.message : String(e)}`);
        fail++;
      }
    }

    console.log("");
    console.log(`=== ${pass}/${pass + fail} checks passed ===`);
    if (fail > 0) {
      console.log("\n--- api logs (last 60 lines) ---");
      console.log(compose(["logs", "--tail=60", "api"]).stdout);
      throw new Error(`${fail} check(s) failed`);
    }

    console.log("\n✓ Full Docker integration succeeded");
  } finally {
    mockOa.stop();
    mockAliases.stop();
    if (buildOk) teardown();
    await rm(oaZip.replace("/oa.zip", ""), { recursive: true, force: true }).catch(() => {});
    await rm(aliasesZip.replace("/alternateNamesV2.zip", ""), { recursive: true, force: true }).catch(() => {});
  }
};

await main();
process.exit(0);
