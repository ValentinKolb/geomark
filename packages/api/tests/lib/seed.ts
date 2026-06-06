import { Hono } from "hono";
import { ingestAll } from "../../src/loader/ingest";
import { fetchManifest } from "../../src/loader/manifest";
import {
  ADDR_DE_CSV,
  ADDR_US_CSV,
  ALIASES_CSV,
  COUNTRIES_CSV,
  PLACES_CSV,
  POSTAL_CSV,
} from "./fixtures";

const compress = async (data: string): Promise<Uint8Array> => {
  const p = Bun.spawn(["zstd", "-q"], { stdin: "pipe", stdout: "pipe" });
  p.stdin.write(new TextEncoder().encode(data));
  await p.stdin.end();
  const b = new Uint8Array(await new Response(p.stdout).arrayBuffer());
  if ((await p.exited) !== 0) throw new Error("zstd compress failed");
  return b;
};

const sha256 = async (b: Uint8Array): Promise<string> => {
  const d = new Uint8Array(
    await crypto.subtle.digest("SHA-256", b as BufferSource),
  );
  let hex = "";
  for (const x of d) hex += x.toString(16).padStart(2, "0");
  return hex;
};

const lc = (s: string): number => (s.match(/\n/g) ?? []).length;

export type SeedHandle = {
  baseUrl: string;
  fingerprint: string;
  stop: () => void;
};

/**
 * Spin up a tiny HTTP server that serves a synthetic data manifest +
 * compressed shards on a docker-assigned random port. Returns the base
 * URL so callers can run `ingestAll(baseUrl, manifest, fp)` against it.
 *
 * Pass `{ aliases: true }` to also serve the synthetic aliases.csv.zst
 * artefact — used by tests that exercise the alias-aware code paths.
 */
export const startMockDataServer = async (
  opts: { aliases?: boolean } = {},
): Promise<{
  baseUrl: string;
  manifest: Awaited<ReturnType<typeof fetchManifest>>;
  fingerprint: string;
  stop: () => void;
}> => {
  const places = await compress(PLACES_CSV);
  const postal = await compress(POSTAL_CSV);
  const countries = await compress(COUNTRIES_CSV);
  const addrDe = await compress(ADDR_DE_CSV);
  const addrUs = await compress(ADDR_US_CSV);
  const aliases = opts.aliases ? await compress(ALIASES_CSV) : null;

  const fp = `fp-${crypto.randomUUID().slice(0, 8)}`;
  const manifest = {
    built_at: new Date().toISOString(),
    version: `test-${fp}`,
    license: { geonames: "CC-BY-4.0" },
    files: {
      places: { filename: "places.csv.zst", sha256: await sha256(places), size_bytes: places.byteLength, line_count: lc(PLACES_CSV) },
      postal_codes: { filename: "postal_codes.csv.zst", sha256: await sha256(postal), size_bytes: postal.byteLength, line_count: lc(POSTAL_CSV) },
      countries: { filename: "countries.csv.zst", sha256: await sha256(countries), size_bytes: countries.byteLength, line_count: lc(COUNTRIES_CSV) },
      addresses: [
        { filename: "addresses-de.csv.zst", sha256: await sha256(addrDe), size_bytes: addrDe.byteLength, line_count: lc(ADDR_DE_CSV), country_code: "DE" },
        { filename: "addresses-us.csv.zst", sha256: await sha256(addrUs), size_bytes: addrUs.byteLength, line_count: lc(ADDR_US_CSV), country_code: "US" },
      ],
      ...(aliases
        ? {
            aliases: {
              filename: "aliases.csv.zst",
              sha256: await sha256(aliases),
              size_bytes: aliases.byteLength,
              line_count: lc(ALIASES_CSV),
            },
          }
        : {}),
    },
    coverage: { DE: "address", US: "address" },
    sources: {
      geonames_cities_url: "https://example.com/cities.zip",
      geonames_postal_url: "https://example.com/postal.zip",
      geonames_country_info_url: "https://example.com/countryInfo.txt",
      openaddresses_url: "https://example.com/oa.zip",
      ...(aliases ? { geonames_aliases_url: "https://example.com/aliases.zip" } : {}),
    },
  };

  const files: Record<string, Uint8Array> = {
    "places.csv.zst": places,
    "postal_codes.csv.zst": postal,
    "countries.csv.zst": countries,
    "addresses-de.csv.zst": addrDe,
    "addresses-us.csv.zst": addrUs,
    ...(aliases ? { "aliases.csv.zst": aliases } : {}),
  };

  const app = new Hono();
  app.get("/latest.json", (c) => c.json(manifest));
  app.get("/:filename", (c) => {
    const b = files[c.req.param("filename")];
    if (!b) return c.json({ error: "nf" }, 404);
    return new Response(b as BodyInit, { headers: { "Content-Type": "application/zstd" } });
  });
  // Random free port
  const server = Bun.serve({ port: 0, fetch: app.fetch });
  const baseUrl = `http://localhost:${server.port}`;

  // Re-fetch through the actual loader path so we exercise the same code
  // paths and get the validated Manifest type.
  const validated = await fetchManifest(baseUrl);

  return {
    baseUrl,
    manifest: validated,
    fingerprint: fp,
    stop: () => server.stop(true),
  };
};

/** Full happy-path seed: starts mock server, ingests, leaves server running. */
export const seedDataset = async (
  opts: { aliases?: boolean } = {},
): Promise<SeedHandle> => {
  const mock = await startMockDataServer(opts);
  try {
    await ingestAll(mock.baseUrl, mock.manifest, mock.fingerprint);
  } catch (e) {
    // Don't leak the HTTP server on a failed ingest.
    mock.stop();
    throw e;
  }
  return {
    baseUrl: mock.baseUrl,
    fingerprint: mock.fingerprint,
    stop: mock.stop,
  };
};
