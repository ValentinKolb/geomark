import { ssr } from "../../config";
import { config } from "../config";
import Showcase from "../components/Showcase.island";
import LiveWorldMap from "../components/LiveWorldMap.island";

/**
 * Geomark — homepage.
 *
 * Sections:
 *   1. Hero            — what it is + two paths (hosted / self-host)
 *   2. Live showcase   — /v1/search, hits the live API
 *   3. Endpoints       — every documented route, one line each
 *   4. Data            — sources, licenses, live counts, download link
 *   5. Run it          — hosted vs self-host, side by side
 *   6. Tech            — stack facts (no marketing adjectives)
 *   7. Footer          — links + license + you-are-here
 */

// ─── decorative subcomponents ─────────────────────────────────────────────

const CompassRose = (p: { class?: string }) => (
  <svg viewBox="0 0 100 100" class={`compass-spin ${p.class ?? ""}`} aria-hidden="true">
    <circle cx="50" cy="50" r="46" fill="none" stroke="var(--color-line)" stroke-width="0.4" />
    <circle cx="50" cy="50" r="36" fill="none" stroke="var(--color-line)" stroke-width="0.3" />
    <circle cx="50" cy="50" r="24" fill="none" stroke="var(--color-line-strong)" stroke-width="0.5" />
    {Array.from({ length: 16 }, (_, i) => {
      const a = (i * Math.PI) / 8;
      const r1 = i % 4 === 0 ? 14 : i % 2 === 0 ? 22 : 26;
      // Cardinal axes stop short of the outer ring so the N/E/S/W
      // letters sitting in that ring stay readable.
      const r2 = i % 4 === 0 ? 38 : i % 2 === 0 ? 35 : 30;
      return (
        <line
          x1={50 + Math.cos(a) * r1}
          y1={50 + Math.sin(a) * r1}
          x2={50 + Math.cos(a) * r2}
          y2={50 + Math.sin(a) * r2}
          stroke={i % 4 === 0 ? "var(--color-marker)" : "var(--color-line-strong)"}
          stroke-width={i % 4 === 0 ? 0.6 : 0.3}
        />
      );
    })}
    {/* Letters get an ink-colored stroke (paint-order: stroke) — acts as
        a halo that masks any axis line passing through the glyph. */}
    <g
      font-family="var(--font-mono)"
      stroke="var(--color-ink)"
      stroke-width="1.4"
      paint-order="stroke"
    >
      <text x="50" y="9"   text-anchor="middle" font-size="5" fill="var(--color-marker)">N</text>
      <text x="91.5" y="52" text-anchor="middle" font-size="4" fill="var(--color-bone-dim)">E</text>
      <text x="50" y="96"  text-anchor="middle" font-size="4" fill="var(--color-bone-dim)">S</text>
      <text x="8" y="52"   text-anchor="middle" font-size="4" fill="var(--color-bone-dim)">W</text>
    </g>
    <circle cx="50" cy="50" r="1.6" fill="var(--color-marker)" />
  </svg>
);

const TopoLines = () => (
  <svg
    width="100%"
    height="100%"
    viewBox="0 0 1200 600"
    preserveAspectRatio="none"
    aria-hidden="true"
    class="absolute inset-0 pointer-events-none"
  >
    <g fill="none" stroke="var(--color-line-strong)" stroke-width="0.6">
      <path class="topo-path"     d="M -50 320 C 200 220, 380 380, 600 300 C 820 220, 980 360, 1250 280" />
      <path class="topo-path-rev" d="M -50 380 C 220 480, 420 320, 640 400 C 860 480, 1000 340, 1250 420" />
      <path class="topo-path"     d="M -50 240 C 180 160, 360 300, 560 220 C 760 140, 960 280, 1250 200" opacity="0.6" />
      <path class="topo-path-rev" d="M -50 460 C 260 540, 440 400, 660 480 C 860 620, 1040 420, 1250 500" opacity="0.6" />
      <path class="topo-path"     d="M -50 160 C 200  80, 380 240, 600 140 C 820  60, 980 220, 1250 120" opacity="0.4" />
      <path class="topo-path-rev" d="M -50 540 C 220 600, 420 460, 640 540 C 860 620, 1020 480, 1250 580" opacity="0.4" />
    </g>
  </svg>
);

const SectionLabel = (p: { label: string; coord: string; icon: string }) => (
  <div class="section-divider">
    <div class="flex items-baseline gap-3">
      <i class={`ti ${p.icon} text-[var(--color-marker)] text-base translate-y-[2px]`} aria-hidden="true" />
      <span class="mono-cap">{p.label}</span>
    </div>
    <span class="coord hidden md:inline">{p.coord}</span>
  </div>
);

// ─── live data fetched at SSR time ────────────────────────────────────────

type ReadyInfo = {
  status: string;
  dataset_version: string | null;
  data_loaded_at: string | null;
  places_count: number;
  addresses_count: number;
  postal_codes_count: number;
};

const fetchReady = async (): Promise<ReadyInfo | null> => {
  try {
    const r = await fetch(`${config.apiUrl}/ready`, {
      signal: AbortSignal.timeout(1000),
    });
    if (!r.ok) return null;
    return (await r.json()) as ReadyInfo;
  } catch {
    return null;
  }
};

const fmtNum = (n: number) => n.toLocaleString("en-US");

// ─── endpoint catalog ─────────────────────────────────────────────────────

const ENDPOINTS: { method: "GET" | "POST"; path: string; desc: string }[] = [
  { method: "GET",  path: "/v1/search",                desc: "Forward search by free text. BM25 ranking, trigram fuzzy, unaccent." },
  { method: "GET",  path: "/v1/reverse",               desc: "Coordinates → places, ordered by distance, bounded by radius." },
  { method: "POST", path: "/v1/batch",                 desc: "Up to 100 search or reverse queries in one request." },
  { method: "GET",  path: "/v1/place/{gid}",           desc: "Place by ID, with all aliases (alternate names, IATA/ICAO, links)." },
  { method: "GET",  path: "/v1/code/{kind}/{value}",   desc: "Lookup by alternate code: IATA, ICAO, Wikidata, postal variant." },
  { method: "GET",  path: "/v1/postal",                desc: "Postal codes by code, place name, or country." },
  { method: "GET",  path: "/v1/countries",             desc: "Country list with metadata and place counts." },
  { method: "GET",  path: "/v1/countries/{code}",      desc: "Country metadata for a 2-letter ISO 3166-1 alpha-2 code." },
  { method: "GET",  path: "/v1/coverage",              desc: "Per-country deepest available layer (address / place_only / none)." },
  { method: "GET",  path: "/v1/attribution",           desc: "Data sources, licenses, attribution strings — required reading before redistributing." },
  { method: "GET",  path: "/v1/random",                desc: "Up to 5000 random places. Filter by country or min_population — indexed and short-cached for visualisations." },
];

// ─── page ─────────────────────────────────────────────────────────────────

export default ssr(async (c) => {
  const page = c.get("page");
  page.title = "Geomark — geocoding for places, addresses, and postal codes";
  page.description =
    "Open-source geocoding API. Forward search, reverse lookup, postal codes, multilingual aliases. Run it on your own infrastructure or use the free hosted version at geomark.dev.";

  const ready = await fetchReady();

  return () => (
    <div class="min-h-screen bg-[var(--color-ink)] text-[var(--color-bone)] relative overflow-hidden">

      {/* ─── top strip ──────────────────────────────────────────────────── */}
      <div class="fixed top-0 left-0 right-0 z-50 backdrop-blur-sm bg-[var(--color-ink)]/80 border-b border-[var(--color-line)]">
        <div class="max-w-[1280px] mx-auto px-4 md:px-6 py-3 flex items-center justify-between gap-3 text-[11px]">
          <div class="flex items-center gap-3 font-mono shrink-0">
            <span class="beacon-dot" />
            <span class="text-[var(--color-bone)]">geomark</span>
            <span class="text-[var(--color-bone-fade)] hidden sm:inline">/</span>
            <span class="text-[var(--color-bone-dim)] hidden sm:inline">v0.1</span>
          </div>
          <nav class="flex items-center gap-3 md:gap-5 font-mono text-[10.5px] uppercase tracking-widest">
            <a href="/data" class="text-[var(--color-bone-dim)] hover:text-[var(--color-marker)]">data</a>
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

      {/* graticule background, full-page */}
      <div class="fixed inset-0 bg-graticule pointer-events-none opacity-60" />

      {/* content column */}
      <div class="relative z-10 max-w-[1280px] mx-auto px-4 md:px-6 pt-20 md:pt-24 pb-24">

        {/* ─── HERO ─────────────────────────────────────────────────────── */}
        {/* Heights are content-sized — no fixed vh — so the buttons stay
            visible above the fold on common laptop viewports (≥720px). */}
        <section class="relative py-6 md:py-12 mb-12 md:mb-20">
          <div class="absolute inset-0 -mx-4 md:-mx-6 overflow-hidden">
            <TopoLines />
          </div>
          <div class="absolute top-0 right-0 md:right-8 opacity-90 pointer-events-none">
            <CompassRose class="w-[90px] h-[90px] md:w-[180px] md:h-[180px]" />
          </div>

          <div class="relative max-w-3xl">
            <h1 class="display text-[clamp(2.5rem,8vw,6rem)] mb-5 md:mb-6">
              Atlas of the
              <br />
              <span class="display-italic marker-glow text-[var(--color-marker)]">
                addressable
              </span>{" "}
              world.
            </h1>

            <p class="text-base md:text-lg max-w-2xl text-[var(--color-bone)]/90 leading-relaxed mb-3 md:mb-4">
              A geocoding API for places, addresses, and postal codes.
              Forward search, reverse lookup, multilingual aliases, fuzzy
              matching.
            </p>

            <p class="text-sm md:text-base max-w-2xl text-[var(--color-bone-dim)] leading-relaxed mb-6 md:mb-8">
              Run it on your own infrastructure with the open-source
              binary, or use the free hosted version at{" "}
              <a href="https://geomark.dev" class="coord-tide hover:underline">
                geomark.dev
              </a>.
            </p>

            <div class="flex flex-wrap items-center gap-3">
              <a href="#try" class="btn btn-primary">
                Try it <i class="ti ti-arrow-down" aria-hidden="true" />
              </a>
              <a href="/docs" class="btn btn-ghost">
                <i class="ti ti-book" aria-hidden="true" /> Read the docs
              </a>
              <a
                href="https://github.com/valentinkolb/geomark"
                class="btn btn-link"
              >
                <i class="ti ti-brand-github" aria-hidden="true" /> source
              </a>
            </div>
          </div>
        </section>

        {/* ─── LIVE SHOWCASE ────────────────────────────────────────────── */}
        <section id="try" class="mb-24 md:mb-32 scroll-mt-24">
          <Showcase />
        </section>

        {/* ─── ENDPOINTS ────────────────────────────────────────────────── */}
        <section class="mb-24 md:mb-32">
          <SectionLabel label="Endpoints" coord="11 routes · prefix /v1" icon="ti-route" />

          <p class="text-[var(--color-bone-dim)] max-w-2xl mb-8 md:mb-10">
            Every route returns JSON. Errors share the shape{" "}
            <code class="code-inline">{"{ error, code }"}</code>. Full
            schemas, parameters, and examples live in the{" "}
            <a href="/docs" class="coord-tide hover:underline">
              OpenAPI spec
            </a>.
          </p>

          <div class="border border-[var(--color-line)]">
            {ENDPOINTS.map((e, i) => (
              <div
                class={`grid grid-cols-[auto_1fr] md:grid-cols-[auto_minmax(280px,auto)_1fr] gap-x-4 md:gap-x-6 gap-y-1 px-4 md:px-6 py-3 md:py-4 ${i > 0 ? "border-t border-[var(--color-line)]" : ""} hover:bg-[var(--color-ink-rise)]/40 transition-colors`}
              >
                <span
                  class={`font-mono text-[10.5px] tracking-widest font-medium self-baseline mt-[3px] ${e.method === "POST" ? "text-[var(--color-marker)]" : "text-[var(--color-tide)]"}`}
                >
                  {e.method}
                </span>
                <code class="font-mono text-sm md:text-[15px] text-[var(--color-bone)] self-baseline">
                  {e.path}
                </code>
                <p class="col-start-2 md:col-start-3 text-sm text-[var(--color-bone-dim)] leading-relaxed">
                  {e.desc}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* ─── DATA ─────────────────────────────────────────────────────── */}
        <section class="mb-24 md:mb-32">
          <SectionLabel label="Data" coord="GeoNames + OpenAddresses" icon="ti-database" />

          <div class="grid md:grid-cols-12 gap-6 md:gap-10 mb-8 md:mb-10">
            <div class="md:col-span-7 space-y-5 text-[var(--color-bone-dim)] leading-relaxed">
              <p>
                Places, postal codes, countries, and aliases come from{" "}
                <a
                  href="https://www.geonames.org/"
                  class="text-[var(--color-bone)] hover:text-[var(--color-marker)]"
                >
                  GeoNames
                </a>{" "}
                under{" "}
                <a
                  href="https://creativecommons.org/licenses/by/4.0/"
                  class="text-[var(--color-bone)] hover:text-[var(--color-marker)]"
                >
                  CC&nbsp;BY&nbsp;4.0
                </a>.
                Addresses come from the{" "}
                <a
                  href="https://openaddresses.io/"
                  class="text-[var(--color-bone)] hover:text-[var(--color-marker)]"
                >
                  OpenAddresses
                </a>{" "}
                community — licenses vary per source (CC0, CC BY, ODbL,
                public domain).
              </p>
              <p>
                The dataset is rebuilt monthly from upstream sources. The
                raw, compressed CSV bundles are served alongside the API
                at{" "}
                <a href="/data" class="coord-tide hover:underline">
                  geomark.dev/data
                </a>{" "}
                — pull them once and run your own queries locally if you
                prefer that to hitting the API.
              </p>
              <p>
                Attribution stays with the data. Anything you republish
                must keep the credit lines from{" "}
                <code class="code-inline">/v1/attribution</code> intact.
              </p>
            </div>

            <div class="md:col-span-5 panel">
              <div class="flex items-baseline justify-between mb-4 gap-2 flex-wrap">
                <span class="mono-cap flex items-center gap-2">
                  <i class="ti ti-pulse" aria-hidden="true" /> live state
                </span>
                <span class="coord flex items-center gap-1.5 text-[var(--color-bone-fade)]">
                  <span class="beacon-dot" />
                  GET /ready
                </span>
              </div>
              {ready ? (
                <dl class="space-y-3 font-mono text-sm">
                  <div class="flex justify-between gap-4">
                    <dt class="text-[var(--color-bone-dim)]">places</dt>
                    <dd class="coord-tide">{fmtNum(ready.places_count)}</dd>
                  </div>
                  <div class="flex justify-between gap-4">
                    <dt class="text-[var(--color-bone-dim)]">addresses</dt>
                    <dd class="coord-tide">{fmtNum(ready.addresses_count)}</dd>
                  </div>
                  <div class="flex justify-between gap-4">
                    <dt class="text-[var(--color-bone-dim)]">postal codes</dt>
                    <dd class="coord-tide">{fmtNum(ready.postal_codes_count)}</dd>
                  </div>
                  <div class="border-t border-[var(--color-line)] pt-3 mt-3 flex justify-between gap-4">
                    <dt class="text-[var(--color-bone-dim)]">version</dt>
                    <dd class="text-[var(--color-bone)]">
                      {ready.dataset_version ?? "—"}
                    </dd>
                  </div>
                </dl>
              ) : (
                <div class="coord text-[var(--color-bone-fade)]">
                  hosted state unavailable — try /ready directly
                </div>
              )}
            </div>
          </div>

          <div class="panel">
            <div class="flex items-baseline justify-between mb-4 gap-3 flex-wrap">
              <span class="mono-cap flex items-center gap-2">
                <i class="ti ti-world" aria-hidden="true" /> sample of the dataset
              </span>
              <span class="coord flex items-center gap-1.5 text-[var(--color-bone-fade)]">
                <span class="beacon-dot" />
                GET /v1/random?limit=2000 · shared cache
              </span>
            </div>
            <LiveWorldMap />
            <div class="flex items-baseline justify-between mt-3 gap-3 flex-wrap coord text-[var(--color-bone-fade)]">
              <span>2000 random places · refreshed through a shared short cache</span>
              <span class="flex items-center gap-3">
                <span class="flex items-center gap-1.5">
                  <span class="inline-block w-1.5 h-1.5 rounded-full bg-[var(--color-marker)]" />
                  pop. ≥ 500k
                </span>
                <span class="flex items-center gap-1.5">
                  <span class="inline-block w-1.5 h-1.5 rounded-full bg-[var(--color-bone)] opacity-55" />
                  everything else
                </span>
              </span>
            </div>
          </div>

        </section>

        {/* ─── RUN IT ───────────────────────────────────────────────────── */}
        <section class="mb-24 md:mb-32">
          <SectionLabel label="Run it" coord="hosted or self-host" icon="ti-server" />

          <div class="grid md:grid-cols-2 gap-4 md:gap-6">

            {/* Hosted */}
            <div class="panel flex flex-col gap-5">
              <div class="flex items-baseline justify-between gap-2 flex-wrap">
                <span class="mono-cap flex items-center gap-2">
                  <i class="ti ti-cloud" aria-hidden="true" /> Hosted
                </span>
                <span class="coord">free · no signup</span>
              </div>

              <p class="text-[var(--color-bone-dim)] leading-relaxed">
                The same binary that ships with the source, running at{" "}
                <code class="code-inline">geomark.dev/api</code>. Free,
                rate-limited per IP, no account required.
              </p>

              <pre class="code-block">
<span class="text-[var(--color-bone-fade)]">$</span> <span class="text-[var(--color-marker)]">curl</span> <span class="text-[var(--color-bone)]">https://geomark.dev/v1/search</span> \{"\n"}
{"  "}-G --data-urlencode <span class="coord-tide">'q=berlin'</span>
              </pre>

              <ul class="space-y-2 text-sm text-[var(--color-bone-dim)]">
                <li class="flex items-baseline gap-3">
                  <i class="ti ti-check text-[var(--color-marker)] shrink-0" aria-hidden="true" />
                  Same code as the open-source binary
                </li>
                <li class="flex items-baseline gap-3">
                  <i class="ti ti-check text-[var(--color-marker)] shrink-0" aria-hidden="true" />
                  No tracking, no auth, no API key
                </li>
                <li class="flex items-baseline gap-3">
                  <i class="ti ti-check text-[var(--color-marker)] shrink-0" aria-hidden="true" />
                  Rate-limited at the edge (per-IP)
                </li>
              </ul>
            </div>

            {/* Self-host */}
            <div class="panel flex flex-col gap-5">
              <div class="flex items-baseline justify-between gap-2 flex-wrap">
                <span class="mono-cap flex items-center gap-2">
                  <i class="ti ti-server-bolt" aria-hidden="true" /> Self-host
                </span>
                <span class="coord">your data · your infra</span>
              </div>

              <p class="text-[var(--color-bone-dim)] leading-relaxed">
                Four containers behind one compose file: PostgreSQL +
                PostGIS (<code class="code-inline">db</code>), the data
                loader (<code class="code-inline">data</code>), the API
                (<code class="code-inline">api</code>), and the
                geomark.dev landing (<code class="code-inline">web</code>).
                Loads upstream data on first start.
              </p>

              <pre class="code-block">
<span class="text-[var(--color-bone-fade)]">$</span> <span class="text-[var(--color-marker)]">git clone</span> <span class="text-[var(--color-bone)]">https://github.com/valentinkolb/geomark</span>{"\n"}
<span class="text-[var(--color-bone-fade)]">$</span> <span class="text-[var(--color-marker)]">cd</span> geomark{"\n"}
<span class="text-[var(--color-bone-fade)]">$</span> <span class="text-[var(--color-marker)]">docker compose up -d</span>
              </pre>

              <ul class="space-y-2 text-sm text-[var(--color-bone-dim)]">
                <li class="flex items-baseline gap-3">
                  <i class="ti ti-check text-[var(--color-marker)] shrink-0" aria-hidden="true" />
                  MIT license, no telemetry
                </li>
                <li class="flex items-baseline gap-3">
                  <i class="ti ti-check text-[var(--color-marker)] shrink-0" aria-hidden="true" />
                  PostgreSQL 17 + PostGIS, ~1&nbsp;GB working set
                </li>
                <li class="flex items-baseline gap-3">
                  <i class="ti ti-check text-[var(--color-marker)] shrink-0" aria-hidden="true" />
                  Optional bearer-auth, configurable rate limit
                </li>
              </ul>
            </div>

          </div>
        </section>

        {/* ─── TECH ─────────────────────────────────────────────────────── */}
        <section class="mb-24 md:mb-32">
          <SectionLabel label="Under the hood" coord="MIT · CC BY 4.0" icon="ti-stack-2" />

          <div class="grid md:grid-cols-2 gap-x-12 gap-y-2">
            {[
              ["Runtime",     "Hono on Bun. Single binary, no Node toolchain."],
              ["Database",    "PostgreSQL 17 + PostGIS + pg_trgm + unaccent + pg_textsearch."],
              ["Search rank", "BM25 with trigram fuzzy fallback, unaccent normalization."],
              ["Reverse",     "GiST spatial index, ST_DistanceSphere, per-axis bbox prefilter."],
              ["Aliases",     "Joined alias table — ranks across all language names, returns matched_alias."],
              ["License",     "MIT for the API code, CC BY 4.0 for the redistributed dataset."],
            ].map(([k, v]) => (
              <div class="grid grid-cols-[140px_1fr] gap-4 py-3 border-t border-[var(--color-line)] first:border-t-0 md:first:border-t md:[&:nth-child(2)]:border-t">
                <span class="mono-cap pt-1">{k}</span>
                <span class="text-sm text-[var(--color-bone)]/85 leading-relaxed">{v}</span>
              </div>
            ))}
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

          {/* triangulation strip */}
          <div class="mt-10 md:mt-12 overflow-hidden border-t border-[var(--color-line)] pt-4 flex gap-6 md:gap-8 font-mono text-[10px] text-[var(--color-bone-fade)] whitespace-nowrap">
            {Array.from({ length: 14 }).map((_, i) => (
              <span class={`flex items-center gap-1 ${i % 3 === 0 ? "text-[var(--color-marker)]" : ""}`}>
                <i class="ti ti-target" aria-hidden="true" />
                48.4011° N · 9.9876° E
              </span>
            ))}
          </div>
        </footer>

      </div>
    </div>
  );
});
