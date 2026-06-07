#!/usr/bin/env bun
/**
 * Full end-to-end Docker integration: builds the image, runs it with a
 * mock OpenAddresses server reachable from inside the container, waits
 * for the FULL initial build to complete, then verifies the manifest +
 * downloads every published artifact and checks its SHA-256.
 *
 * Usage: bun run packages/data/scripts/integration-docker-full.ts
 *        (run from the monorepo root)
 *
 * Requires: docker daemon running, host.docker.internal reachable
 * (true on Docker Desktop; on Linux we add the necessary host-gateway flag).
 */
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const IMAGE = "geomark-data:full-test";
const CONTAINER = "geomark-data-full-test";
const HOST_PORT = "4299";
const MOCK_PORT = 19981;

const GEONAMES_CITIES = "https://download.geonames.org/export/dump/cities15000.zip";
const GEONAMES_POSTAL = "https://download.geonames.org/export/zip/allCountries.zip";
const GEONAMES_COUNTRY_INFO = "https://download.geonames.org/export/dump/countryInfo.txt";

const sh = async (cmd: string[], opts: { silent?: boolean } = {}): Promise<string> => {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  const exit = await proc.exited;
  if (exit !== 0 && !opts.silent) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`command failed (${exit}): ${cmd.join(" ")}\n${err}`);
  }
  return out;
};

const buildOaZip = async (zipPath: string): Promise<void> => {
  const stagingDir = `${zipPath}.src`;
  const oaSubdir = join(stagingDir, "openaddresses");
  await mkdir(oaSubdir, { recursive: true });

  await Bun.write(
    join(oaSubdir, "de.csv"),
    "HASH,LON,LAT,NUMBER,STREET,UNIT,CITY,DISTRICT,REGION,POSTCODE\n" +
      "abc1,13.41053,52.52437,12,Müllerstraße,,Berlin,Mitte,Berlin,10115\n" +
      "abc2,13.42000,52.51000,5,Friedrichstraße,,Berlin,Mitte,Berlin,10117\n" +
      "abc3,11.57500,48.13700,7a,Marienplatz,,München,,Bayern,80331\n",
  );
  await Bun.write(
    join(oaSubdir, "us.csv"),
    "HASH,LON,LAT,NUMBER,STREET,UNIT,CITY,DISTRICT,REGION,POSTCODE\n" +
      "us001,-74.00597,40.71427,1,Broadway,,New York,,NY,10004\n" +
      "us002,-122.41942,37.77493,2300,Fillmore St,Apt 3,San Francisco,,CA,94115\n",
  );

  const proc = Bun.spawn(["zip", "-q", "-r", zipPath, "openaddresses"], {
    cwd: stagingDir,
    stderr: "pipe",
  });
  if ((await proc.exited) !== 0) {
    throw new Error(`zip failed: ${await new Response(proc.stderr).text()}`);
  }
};

const sha256Hex = (bytes: Uint8Array): string =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

const main = async (): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), "geomark-docker-full-"));
  const oaZip = join(dir, "openaddresses.zip");

  console.log("=".repeat(60));
  console.log("Geomark — full Docker integration");
  console.log("=".repeat(60));
  console.log(`tmp:        ${dir}`);
  console.log(`mock OA:    http://host.docker.internal:${MOCK_PORT}/openaddresses.zip`);
  console.log(`container:  ${CONTAINER} on host port ${HOST_PORT}`);
  console.log("");

  await buildOaZip(oaZip);
  const mockServer = Bun.serve({
    port: MOCK_PORT,
    hostname: "0.0.0.0",
    fetch: async () => new Response(Bun.file(oaZip).stream(), {
      headers: { "Content-Type": "application/zip" },
    }),
  });
  console.log(`mock OA listening on :${MOCK_PORT}`);

  await sh(["docker", "rm", "-f", CONTAINER], { silent: true });

  console.log("==> Building image…");
  const buildProc = Bun.spawn(
    ["docker", "build", "-f", "packages/data/Dockerfile", "-t", IMAGE, "."],
    { stdout: "ignore", stderr: "pipe" },
  );
  if ((await buildProc.exited) !== 0) {
    const err = await new Response(buildProc.stderr).text();
    throw new Error(`docker build failed: ${err}`);
  }

  console.log("==> Starting container…");
  await sh([
    "docker", "run", "-d",
    "--name", CONTAINER,
    "--add-host", "host.docker.internal:host-gateway",
    "-e", "OUTPUT_DIR=/tmp/data",
    "-e", `GEONAMES_CITIES_URL=${GEONAMES_CITIES}`,
    "-e", `GEONAMES_POSTAL_URL=${GEONAMES_POSTAL}`,
    "-e", `GEONAMES_COUNTRY_INFO_URL=${GEONAMES_COUNTRY_INFO}`,
    "-e", `OPENADDRESSES_URL=http://host.docker.internal:${MOCK_PORT}/openaddresses.zip`,
    "-e", "REFRESH_INTERVAL_DAYS=30",
    "-p", `${HOST_PORT}:3000`,
    IMAGE,
  ]);

  // 1) Health must come up immediately, BEFORE the build completes
  console.log("==> Waiting for /health…");
  let healthOk = false;
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(`http://localhost:${HOST_PORT}/health`);
      if (r.ok) {
        healthOk = true;
        console.log(`/health up after ${i}s`);
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!healthOk) throw new Error("/health did not come up within 30s");

  // 2) Wait for the actual build to finish — manifest appears via /latest.json
  console.log("==> Waiting for build to finish (polling /latest.json)…");
  let manifest: any = null;
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://localhost:${HOST_PORT}/latest.json`);
      if (r.ok) {
        manifest = await r.json();
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 5000));
  }
  if (!manifest) {
    console.log("==> BUILD TIMED OUT. Container logs:");
    console.log(await sh(["docker", "logs", CONTAINER]));
    throw new Error("build did not finish in 5 minutes");
  }

  console.log("");
  console.log("==> Manifest:");
  console.log(`  built_at:  ${manifest.built_at}`);
  console.log(`  version:   ${manifest.version}`);
  console.log(`  coverage:  ${Object.keys(manifest.coverage).join(", ")}`);
  console.log("  files:");
  for (const [name, e] of Object.entries(manifest.files)) {
    if (Array.isArray(e)) {
      for (const a of e as Array<{ country_code: string; filename: string; size_bytes: number; line_count: number }>) {
        console.log(`    ${a.country_code.padEnd(8)} ${a.filename.padEnd(28)} ${(a.size_bytes / 1024).toFixed(1).padStart(8)} KB · ${a.line_count.toLocaleString()} lines`);
      }
    } else {
      const f = e as { filename: string; size_bytes: number; line_count: number };
      console.log(`    ${name.padEnd(8)} ${f.filename.padEnd(28)} ${(f.size_bytes / 1024).toFixed(1).padStart(8)} KB · ${f.line_count.toLocaleString()} lines`);
    }
  }
  console.log("");

  // 3) Verify each artifact: download + SHA-256 must match manifest
  console.log("==> Verifying every artifact (download + SHA-256)…");
  const artifacts: Array<{ filename: string; sha256: string; size_bytes: number }> = [
    manifest.files.places,
    manifest.files.postal_codes,
    manifest.files.countries,
    ...manifest.files.addresses,
  ];
  let okCount = 0;
  for (const a of artifacts) {
    const r = await fetch(`http://localhost:${HOST_PORT}/${a.filename}`);
    if (!r.ok) {
      console.log(`  ✗ ${a.filename}: HTTP ${r.status}`);
      continue;
    }
    const bytes = new Uint8Array(await r.arrayBuffer());
    const hash = sha256Hex(bytes);
    const sizeOk = bytes.length === a.size_bytes;
    const hashOk = hash === a.sha256;
    if (sizeOk && hashOk) {
      console.log(`  ✓ ${a.filename}`);
      okCount++;
    } else {
      console.log(`  ✗ ${a.filename}: size ${sizeOk ? "ok" : `MISMATCH (${bytes.length}/${a.size_bytes})`}, sha ${hashOk ? "ok" : "MISMATCH"}`);
    }
  }

  console.log("");
  console.log(`==> ${okCount}/${artifacts.length} artifacts verified`);

  // 4) Cleanup
  await sh(["docker", "rm", "-f", CONTAINER], { silent: true });
  mockServer.stop(true);
  await rm(dir, { recursive: true, force: true });

  if (okCount !== artifacts.length) {
    throw new Error("artifact verification failed");
  }
  console.log("");
  console.log("✓ Full Docker integration succeeded");
};

await main();
