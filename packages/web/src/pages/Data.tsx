import { dates, text } from "@valentinkolb/stdlib";
import { ssr } from "../../config";
import { config } from "../config";
import CopyButton from "../components/CopyButton.island";
import { Code } from "../components/Code";

/**
 * /data — dataset distribution page. Lists every artefact in the
 * current bundle with sha256, size, row count, and a copyable curl
 * command. Manifest fetched server-side from the data builder; if it's
 * unreachable the page falls back to a static "see manifest" hint so
 * the page still renders.
 */

// ─── manifest types (mirror packages/data/src/server.ts output) ──────────

type ManifestFile = {
  filename: string;
  sha256: string;
  size_bytes: number;
  line_count: number;
  country_code?: string;
};

type Manifest = {
  built_at: string;
  version: string;
  license: {
    geonames: string;
    openaddresses: string;
    timezone_boundaries?: string;
  };
  files: {
    places: ManifestFile;
    postal_codes: ManifestFile;
    countries: ManifestFile;
    addresses: ManifestFile[];
    aliases?: ManifestFile;
  };
  coverage?: Record<string, "address" | "place_only" | "none">;
  sources?: Record<string, string>;
};

const fetchManifest = async (): Promise<Manifest | null> => {
  const url = `${config.dataUrl}/latest.json`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(2500) });
    if (!r.ok) {
      console.warn(`[geomark/data] manifest fetch ${url} → ${r.status}`);
      return null;
    }
    return (await r.json()) as Manifest;
  } catch (err) {
    console.warn(`[geomark/data] manifest fetch ${url} failed:`, err);
    return null;
  }
};

// ─── pretty-printers ──────────────────────────────────────────────────────
// Prefer stdlib helpers over rolling our own — keeps the formatting
// consistent across the project.

const fmtNum = (n: number) => n.toLocaleString("en-US");

// `text.truncate(s, limit, "middle")` gives us a left/right-preserving
// truncation around an ellipsis, which is exactly what we want for
// hex digests displayed in a tight column.
const shortSha = (sha: string) => text.truncate(sha, 12, "middle");

// ─── per-file schema notes (kept brief; full DDL in packages/api/src/migrate.ts) ─

type SchemaField = { name: string; type: string; note?: string };

const SCHEMAS: Record<string, SchemaField[]> = {
  places: [
    { name: "gid", type: "TEXT", note: "geonames:<geonameid>" },
    { name: "name", type: "TEXT" },
    { name: "asciiname", type: "TEXT" },
    { name: "latitude", type: "DOUBLE PRECISION" },
    { name: "longitude", type: "DOUBLE PRECISION" },
    { name: "feature_class", type: "TEXT" },
    { name: "feature_code", type: "TEXT" },
    { name: "country_code", type: "TEXT" },
    { name: "admin1_code", type: "TEXT" },
    { name: "admin2_code", type: "TEXT" },
    { name: "population", type: "BIGINT" },
    { name: "elevation", type: "INTEGER" },
    { name: "timezone", type: "TEXT" },
  ],
  postal_codes: [
    { name: "country_code", type: "TEXT" },
    { name: "postal_code", type: "TEXT" },
    { name: "place_name", type: "TEXT" },
    { name: "admin_name1", type: "TEXT" },
    { name: "admin_code1", type: "TEXT" },
    { name: "admin_name2", type: "TEXT" },
    { name: "admin_code2", type: "TEXT" },
    { name: "admin_name3", type: "TEXT" },
    { name: "admin_code3", type: "TEXT" },
    { name: "latitude", type: "DOUBLE PRECISION" },
    { name: "longitude", type: "DOUBLE PRECISION" },
    { name: "accuracy", type: "INTEGER" },
  ],
  countries: [
    { name: "code", type: "TEXT", note: "ISO 3166-1 alpha-2" },
    { name: "code3", type: "TEXT", note: "ISO 3166-1 alpha-3" },
    { name: "name", type: "TEXT" },
    { name: "capital", type: "TEXT" },
    { name: "continent", type: "TEXT" },
    { name: "currency_code", type: "TEXT" },
    { name: "languages", type: "TEXT[]" },
    { name: "tld", type: "TEXT" },
  ],
  addresses: [
    { name: "gid", type: "TEXT", note: "oa:<cc>:<hash>" },
    { name: "latitude", type: "DOUBLE PRECISION" },
    { name: "longitude", type: "DOUBLE PRECISION" },
    { name: "country_code", type: "TEXT" },
    { name: "house_number", type: "TEXT" },
    { name: "street", type: "TEXT" },
    { name: "unit", type: "TEXT" },
    { name: "city", type: "TEXT" },
    { name: "district", type: "TEXT" },
    { name: "region", type: "TEXT" },
    { name: "postcode", type: "TEXT" },
    { name: "label", type: "TEXT", note: "synthesized full-line address" },
  ],
  aliases: [
    { name: "geonameid", type: "BIGINT", note: "matches places.gid" },
    { name: "kind", type: "TEXT", note: "name | abbr | iata | icao | link | post | wkdt | …" },
    { name: "lang", type: "TEXT", note: "BCP 47 tag for kind=name; null otherwise" },
    { name: "value", type: "TEXT" },
    { name: "is_preferred", type: "BOOLEAN" },
  ],
};

// ─── shared section label ────────────────────────────────────────────────

const SectionLabel = (p: { label: string; coord: string; icon: string }) => (
  <div class="section-divider">
    <div class="flex items-baseline gap-3">
      <i class={`ti ${p.icon} text-[var(--color-marker)] text-base translate-y-[2px]`} aria-hidden="true" />
      <span class="mono-cap">{p.label}</span>
    </div>
    <span class="coord hidden md:inline">{p.coord}</span>
  </div>
);

// ─── file row (used for the downloads table) ─────────────────────────────

const FileRow = (p: { f: ManifestFile; baseUrl: string }) => {
  const url = `${p.baseUrl}/${p.f.filename}`;
  const curl = `curl -O ${url}`;
  return (
    <div class="grid grid-cols-1 md:grid-cols-[minmax(220px,1fr)_auto_auto_auto_auto] gap-x-6 gap-y-2 px-4 md:px-6 py-4 border-t border-[var(--color-line)] hover:bg-[var(--color-ink-rise)]/40 transition-colors">
      <div class="flex items-center gap-3">
        <i class="ti ti-file-zip text-[var(--color-bone-dim)]" aria-hidden="true" />
        <a
          href={url}
          class="font-mono text-sm md:text-[15px] text-[var(--color-bone)] hover:text-[var(--color-marker)] truncate"
        >
          {p.f.filename}
        </a>
      </div>
      <div class="coord text-[var(--color-bone)]">
        {fmtNum(p.f.line_count)} <span class="text-[var(--color-bone-fade)]">rows</span>
      </div>
      <div class="coord text-[var(--color-bone)]">{text.pprintBytes(p.f.size_bytes)}</div>
      <div class="coord coord-tide truncate" title={p.f.sha256}>
        sha256:{shortSha(p.f.sha256)}
      </div>
      <div class="md:justify-self-end">
        <CopyButton text={curl} label="curl" />
      </div>
    </div>
  );
};

const SchemaTable = (p: { fields: SchemaField[] }) => (
  <dl class="grid grid-cols-[160px_120px_1fr] md:grid-cols-[200px_140px_1fr] gap-x-6 gap-y-2 text-sm">
    {p.fields.map((f) => (
      <>
        <dt class="font-mono text-[13px] text-[var(--color-bone)]">{f.name}</dt>
        <dd class="coord coord-tide">{f.type}</dd>
        <dd class="coord text-[var(--color-bone-dim)]">{f.note ?? ""}</dd>
      </>
    ))}
  </dl>
);

// ─── page ─────────────────────────────────────────────────────────────────

export default ssr(async (c) => {
  const page = c.get("page");
  page.title = "Geomark — open data";
  page.description =
    "Compressed CSV bundles of places, postal codes, countries, and addresses — built monthly from GeoNames + OpenAddresses, ready to download and query locally.";

  const manifest = await fetchManifest();

  // Public-facing base URL for download examples. The actual files are
  // served by the data builder; this is what users will copy-paste.
  const baseUrl = config.dataPublicUrl;

  return () => (
    <div class="min-h-screen bg-[var(--color-ink)] text-[var(--color-bone)] relative overflow-hidden">

      {/* ─── top strip ──────────────────────────────────────────────────── */}
      <div class="fixed top-0 left-0 right-0 z-50 backdrop-blur-sm bg-[var(--color-ink)]/80 border-b border-[var(--color-line)]">
        <div class="max-w-[1280px] mx-auto px-4 md:px-6 py-3 flex items-center justify-between gap-3 text-[11px]">
          <a href="/" class="flex items-center gap-3 font-mono shrink-0 hover:opacity-80 transition-opacity">
            <span class="beacon-dot" />
            <span class="text-[var(--color-bone)]">geomark</span>
            <span class="text-[var(--color-bone-fade)] hidden sm:inline">/</span>
            <span class="text-[var(--color-bone-dim)] hidden sm:inline">v0.1</span>
          </a>
          <nav class="flex items-center gap-3 md:gap-5 font-mono text-[10.5px] uppercase tracking-widest">
            <a href="/data" class="text-[var(--color-marker)]">data</a>
            <a href="/docs" class="text-[var(--color-bone-dim)] hover:text-[var(--color-marker)]">docs</a>
            <a
              href="https://github.com/valentinkolb/geomark"
              class="text-[var(--color-bone-dim)] hover:text-[var(--color-marker)] flex items-center gap-1"
            >
              <i class="ti ti-brand-github" aria-hidden="true" /> github
            </a>
          </nav>
        </div>
      </div>

      {/* graticule background */}
      <div class="fixed inset-0 bg-graticule pointer-events-none opacity-60" />

      <div class="relative z-10 max-w-[1280px] mx-auto px-4 md:px-6 pt-20 md:pt-24 pb-24">

        {/* ─── PAGE HEADER ──────────────────────────────────────────────── */}
        <header class="mb-16 md:mb-24 max-w-3xl pt-6 md:pt-10">
          <div class="mono-cap mb-4 flex items-center gap-2">
            <i class="ti ti-database" aria-hidden="true" /> open data
          </div>
          <h1 class="display text-[clamp(2.25rem,6vw,4.5rem)] mb-5 md:mb-6">
            The dataset behind{" "}
            <span class="display-italic text-[var(--color-marker)]">Geomark</span>
            .
          </h1>
          <p class="text-base md:text-lg text-[var(--color-bone)]/85 leading-relaxed mb-3">
            Compressed CSV bundles of places, postal codes, countries, and
            addresses. Built monthly from upstream sources, signed with
            sha256, ready to ingest into Postgres or query locally.
          </p>
          <p class="text-sm md:text-base text-[var(--color-bone-dim)] leading-relaxed">
            Same data the API runs on — pull it once and skip the API
            entirely if your workload is offline or batch-y.
          </p>
        </header>

        {/* ─── 1. CREDITS — GeoNames + OpenAddresses prominently ────────── */}
        <section class="mb-16 md:mb-24">
          <SectionLabel
            label="Credits"
            coord="powered by upstream data"
            icon="ti-license"
          />

          <div class="grid md:grid-cols-2 gap-4 md:gap-6">
            <a
              href="https://www.geonames.org/"
              class="panel block group transition-colors hover:border-[var(--color-line-strong)]"
            >
              <div class="flex items-baseline justify-between mb-3 gap-2 flex-wrap">
                <span class="mono-cap flex items-center gap-2">
                  <i class="ti ti-world" aria-hidden="true" /> GeoNames
                </span>
                <span class="coord coord-tide">CC BY 4.0</span>
              </div>
              <p class="text-base text-[var(--color-bone)]/90 leading-relaxed mb-3">
                The bedrock of this entire project. Places, postal codes,
                country metadata, and multilingual aliases — all of it
                comes from the volunteer-maintained{" "}
                <span class="text-[var(--color-bone)] group-hover:text-[var(--color-marker)]">
                  geonames.org
                </span>{" "}
                gazetteer. Without GeoNames, none of this works.
              </p>
              <p class="text-sm text-[var(--color-bone-dim)] leading-relaxed">
                Their <code class="code-inline">cities500</code> dump,{" "}
                <code class="code-inline">allCountries</code> postal codes,
                <code class="code-inline">countryInfo</code> table, and{" "}
                <code class="code-inline">alternateNamesV2</code> aliases.
                Re-downloaded monthly.
              </p>
            </a>

            <a
              href="https://openaddresses.io/"
              class="panel block group transition-colors hover:border-[var(--color-line-strong)]"
            >
              <div class="flex items-baseline justify-between mb-3 gap-2 flex-wrap">
                <span class="mono-cap flex items-center gap-2">
                  <i class="ti ti-map-pin" aria-hidden="true" /> OpenAddresses
                </span>
                <span class="coord coord-tide">mixed</span>
              </div>
              <p class="text-base text-[var(--color-bone)]/90 leading-relaxed mb-3">
                Street-level addresses, contributed per-country by an open
                community of regional maintainers. Per-source licenses:
                CC0, CC BY, ODbL, public domain.
              </p>
              <p class="text-sm text-[var(--color-bone-dim)] leading-relaxed">
                Each country's bundle ships with its source attribution
                file — see{" "}
                <code class="code-inline">openaddresses-attribution.txt</code>{" "}
                in the data archive.
              </p>
            </a>
          </div>

          <p class="coord text-[var(--color-bone-fade)] mt-4">
            Programmatic access:{" "}
            <a href="/api/v1/attribution" class="coord-tide hover:underline">
              /api/v1/attribution
            </a>
          </p>
        </section>

        {/* ─── 2. CURRENT BUNDLE ────────────────────────────────────────── */}
        <section class="mb-16 md:mb-24">
          <SectionLabel
            label="Current bundle"
            coord={
              manifest
                ? `version ${manifest.version}`
                : "manifest unavailable"
            }
            icon="ti-package"
          />

          {manifest ? (
            <>
              {/* Bundle summary */}
              <div class="panel mb-6 md:mb-8">
                <div class="grid grid-cols-2 md:grid-cols-4 gap-4 md:gap-6">
                  <div>
                    <div class="mono-cap mb-1">version</div>
                    <div class="font-mono text-[var(--color-bone)]">
                      {manifest.version}
                    </div>
                  </div>
                  <div>
                    <div class="mono-cap mb-1">built</div>
                    <div class="font-mono text-[var(--color-bone)] text-sm">
                      {dates.formatDate(manifest.built_at)}
                    </div>
                  </div>
                  <div>
                    <div class="mono-cap mb-1">geonames</div>
                    <div class="font-mono coord-tide text-sm">
                      {manifest.license.geonames}
                    </div>
                  </div>
                  <div>
                    <div class="mono-cap mb-1">manifest</div>
                    <a
                      href={`${baseUrl}/latest.json`}
                      class="font-mono text-sm text-[var(--color-bone)] hover:text-[var(--color-marker)]"
                    >
                      latest.json →
                    </a>
                  </div>
                </div>
              </div>

              {/* Files table */}
              <div class="border border-[var(--color-line)]">
                <div class="px-4 md:px-6 py-3 grid grid-cols-1 md:grid-cols-[minmax(220px,1fr)_auto_auto_auto_auto] gap-x-6 mono-cap text-[var(--color-bone-dim)] hidden md:grid">
                  <span>file</span>
                  <span>rows</span>
                  <span>size</span>
                  <span>sha256</span>
                  <span class="md:justify-self-end">curl</span>
                </div>

                <FileRow f={manifest.files.places} baseUrl={baseUrl} />
                <FileRow f={manifest.files.postal_codes} baseUrl={baseUrl} />
                <FileRow f={manifest.files.countries} baseUrl={baseUrl} />
                {manifest.files.aliases && (
                  <FileRow f={manifest.files.aliases} baseUrl={baseUrl} />
                )}
                {manifest.files.addresses.map((f) => (
                  <FileRow f={f} baseUrl={baseUrl} />
                ))}
              </div>

              {manifest.coverage && (
                <div class="coord text-[var(--color-bone-fade)] mt-3">
                  address-level coverage:{" "}
                  {Object.keys(manifest.coverage)
                    .filter((cc) => manifest.coverage![cc] === "address")
                    .sort()
                    .join(", ") || "—"}
                </div>
              )}
            </>
          ) : (
            <div class="panel">
              <p class="coord text-[var(--color-bone-dim)]">
                <i class="ti ti-cloud-off" aria-hidden="true" /> Manifest
                unreachable from this host. Files are still served at{" "}
                <code class="code-inline">{baseUrl}/&lt;filename&gt;.csv.zst</code>
                ; fetch{" "}
                <a href={`${baseUrl}/latest.json`} class="coord-tide hover:underline">
                  latest.json
                </a>{" "}
                directly for the current file list.
              </p>
            </div>
          )}
        </section>

        {/* ─── 3. QUICK START ───────────────────────────────────────────── */}
        <section class="mb-16 md:mb-24">
          <SectionLabel
            label="Quick start"
            coord="download · decompress · query"
            icon="ti-play"
          />

          <div class="space-y-5 md:space-y-6">
            {/* Step 1: download */}
            <div class="panel">
              <div class="flex items-baseline justify-between mb-3 gap-3 flex-wrap">
                <span class="mono-cap flex items-center gap-2">
                  <i class="ti ti-download" aria-hidden="true" /> 1 · download
                </span>
                <CopyButton
                  text={`curl -O ${baseUrl}/places.csv.zst\ncurl -O ${baseUrl}/postal_codes.csv.zst\ncurl -O ${baseUrl}/countries.csv.zst`}
                />
              </div>
              <pre class="code-block overflow-x-auto">
                <Code
                  lang="curl"
                  code={`# pull the current bundle
$ curl -O ${baseUrl}/latest.json
$ curl -O ${baseUrl}/places.csv.zst
$ curl -O ${baseUrl}/postal_codes.csv.zst
$ curl -O ${baseUrl}/countries.csv.zst`}
                />
              </pre>
            </div>

            {/* Step 2: verify + decompress */}
            <div class="panel">
              <div class="flex items-baseline justify-between mb-3 gap-3 flex-wrap">
                <span class="mono-cap flex items-center gap-2">
                  <i class="ti ti-shield-check" aria-hidden="true" /> 2 · verify + decompress
                </span>
                <CopyButton
                  text={`shasum -a 256 -c <(jq -r '.files | to_entries[] | "\\(.value.sha256)  \\(.value.filename)"' latest.json | grep -v null)\nzstd -d *.csv.zst`}
                />
              </div>
              <pre class="code-block overflow-x-auto">
                <Code
                  lang="curl"
                  code={`# check sha256 against the manifest
$ shasum -a 256 places.csv.zst
8b69d2aa68d05f25bd77b1ecbc4e4384b2fd1096b54c268fa4ada10115f99981  places.csv.zst

# decompress
$ zstd -d places.csv.zst postal_codes.csv.zst countries.csv.zst`}
                />
              </pre>
            </div>

            {/* Step 3: load into Postgres */}
            <div class="panel">
              <div class="flex items-baseline justify-between mb-3 gap-3 flex-wrap">
                <span class="mono-cap flex items-center gap-2">
                  <i class="ti ti-database-import" aria-hidden="true" /> 3 · load into Postgres
                </span>
                <CopyButton
                  text={`psql -c "\\\\copy geomark.places FROM 'places.csv' WITH (FORMAT csv, HEADER)"`}
                />
              </div>
              <pre class="code-block overflow-x-auto">
                <Code
                  lang="curl"
                  code={`# table DDL: see packages/api/src/migrate.ts
$ psql -c "\\copy geomark.places FROM 'places.csv' WITH (FORMAT csv, HEADER)"
$ psql -c "\\copy geomark.postal_codes FROM 'postal_codes.csv' WITH (FORMAT csv, HEADER)"
$ psql -c "\\copy geomark.countries FROM 'countries.csv' WITH (FORMAT csv, HEADER)"`}
                />
              </pre>
            </div>

            <p class="coord text-[var(--color-bone-fade)]">
              The same files are what the data loader feeds into the API
              container. If you'd rather hit the API instead of running
              your own Postgres, point at{" "}
              <code class="code-inline">geomark.dev/api/v1/*</code> — see{" "}
              <a href="/docs" class="coord-tide hover:underline">/docs</a>.
            </p>
          </div>
        </section>

        {/* ─── 4. SCHEMA ────────────────────────────────────────────────── */}
        <section class="mb-16 md:mb-24">
          <SectionLabel
            label="Schema"
            coord="csv columns per artefact"
            icon="ti-table"
          />

          <p class="text-sm text-[var(--color-bone-dim)] leading-relaxed mb-6 md:mb-8 max-w-2xl">
            Every CSV is UTF-8, comma-separated, with a header row. Types
            below match the Postgres DDL the API runs (see{" "}
            <code class="code-inline">packages/api/src/migrate.ts</code>);
            most loaders will accept the data as plain text.
          </p>

          <div class="space-y-5 md:space-y-6">
            {[
              { key: "places",       title: "places.csv",        sub: "GeoNames cities" },
              { key: "postal_codes", title: "postal_codes.csv",  sub: "GeoNames postal codes" },
              { key: "countries",    title: "countries.csv",     sub: "ISO 3166 metadata" },
              { key: "addresses",    title: "addresses-{cc}.csv", sub: "OpenAddresses, one file per country" },
              { key: "aliases",      title: "aliases.csv",       sub: "GeoNames alternateNamesV2 (optional)" },
            ].map((s) => (
              <article class="panel">
                <div class="flex items-baseline justify-between mb-4 gap-2 flex-wrap">
                  <span class="font-mono text-base text-[var(--color-bone)]">
                    {s.title}
                  </span>
                  <span class="coord">{s.sub}</span>
                </div>
                <SchemaTable fields={SCHEMAS[s.key]!} />
              </article>
            ))}
          </div>
        </section>

        {/* ─── 5. REDISTRIBUTION ────────────────────────────────────────── */}
        <section class="mb-16 md:mb-24">
          <SectionLabel
            label="Redistribution"
            coord="keep the credit lines"
            icon="ti-license"
          />

          <div class="panel">
            <ul class="space-y-3 text-sm text-[var(--color-bone-dim)] leading-relaxed">
              {[
                ["GeoNames data is CC BY 4.0", "You can use, share, and adapt it commercially. Provide attribution: 'GeoNames — geonames.org (CC BY 4.0)' somewhere visible to your users."],
                ["OpenAddresses is mixed", "Per-country files have per-source licenses. The bundle ships an attribution.txt — preserve it when redistributing."],
                ["Geomark code is MIT", "The API and tooling are MIT. The data above is not — its license follows the upstream sources."],
                ["Programmatic attribution string", "GET /api/v1/attribution returns ready-to-paste credit text in JSON. Copy it into your About page or footer."],
              ].map(([title, desc]) => (
                <li class="flex items-baseline gap-3">
                  <i class="ti ti-check text-[var(--color-marker)] shrink-0 mt-0.5" aria-hidden="true" />
                  <span>
                    <strong class="text-[var(--color-bone)] font-medium">{title}.</strong>{" "}
                    {desc}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* ─── footer ──────────────────────────────────────────────────── */}
        <footer class="border-t border-[var(--color-line)] pt-8 md:pt-10 mt-16 md:mt-20">
          <div class="grid md:grid-cols-12 gap-6 text-sm">
            <div class="md:col-span-6">
              <div class="display text-2xl md:text-3xl mb-2">geomark.dev</div>
              <div class="text-[var(--color-bone-dim)] max-w-md leading-relaxed">
                Open-source geocoding. Data: GeoNames (CC&nbsp;BY&nbsp;4.0)
                and OpenAddresses contributors. Code: MIT.
              </div>
            </div>
            <nav class="md:col-span-3 space-y-2 coord">
              {[
                { href: "/",          label: "home",      icon: "ti-home"             },
                { href: "/data",      label: "data",      icon: "ti-database"         },
                { href: "/docs",      label: "docs",      icon: "ti-book"             },
                { href: "/impressum", label: "impressum", icon: "ti-file-description" },
              ].map((l) => (
                <div>
                  <a href={l.href} class="hover:text-[var(--color-marker)] flex items-center gap-2">
                    <i class={`ti ${l.icon}`} aria-hidden="true" />
                    {l.label}
                  </a>
                </div>
              ))}
            </nav>
            <div class="md:col-span-3 coord space-y-2 md:text-right">
              <div class="text-[var(--color-bone-fade)]">made in Ulm</div>
              <div class="coord-tide">48.4011° N · 9.9876° E</div>
              <div class="text-[var(--color-bone-fade)] flex items-center md:justify-end gap-2">
                <i class="ti ti-current-location" aria-hidden="true" /> you are here
              </div>
            </div>
          </div>
        </footer>

      </div>
    </div>
  );
});
