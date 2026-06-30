import { ssr } from "../../config";
import LangToggle from "../components/LangToggle.island";
import CopyButton from "../components/CopyButton.island";
import { Code } from "../components/Code";

/**
 * Docs page — three sections:
 *
 *   1. How it works  — pipeline diagram + explanation, attributes GeoNames
 *   2. API reference — every /v1/* route with curl + typescript snippets
 *                       (toggle persists in localStorage via the LangToggle
 *                       island; CSS rules in styles.css hide the inactive
 *                       snippet block)
 *   3. Self-deploy   — quick start, env, production checklist
 */

// ─── pipeline diagram (5 steps, horizontal on md+, stacked on mobile) ───

type Step = {
  icon: string;
  title: string;
  sub: string;
  tags: string[];
};

const PIPELINE: Step[] = [
  {
    icon: "ti-archive",
    title: "Upstream",
    sub: "GeoNames + OpenAddresses",
    tags: ["CC BY 4.0", "mixed"],
  },
  {
    icon: "ti-package",
    title: "Loader",
    sub: "downloads, parses, zstd",
    tags: ["monthly refresh"],
  },
  {
    icon: "ti-database",
    title: "Postgres",
    sub: "PostGIS + extensions",
    tags: ["BM25", "GiST", "trgm", "unaccent"],
  },
  {
    icon: "ti-bolt",
    title: "API",
    sub: "/v1/*",
    tags: ["Hono on Bun"],
  },
  {
    icon: "ti-terminal-2",
    title: "Your app",
    sub: "any HTTP client",
    tags: ["curl", "fetch", "…"],
  },
];

const StepBox = (p: { step: Step }) => (
  <div class="panel-tight flex flex-col gap-2 min-w-0">
    <div class="flex items-center gap-2">
      <i class={`ti ${p.step.icon} text-[var(--color-marker)] text-base`} aria-hidden="true" />
      <span class="text-[var(--color-bone)] text-sm font-medium">{p.step.title}</span>
    </div>
    <div class="coord text-[var(--color-bone-dim)]">{p.step.sub}</div>
    <div class="flex flex-wrap gap-1.5">
      {p.step.tags.map((t) => (
        <span class="font-mono text-[10px] tracking-wider uppercase text-[var(--color-bone-fade)] border border-[var(--color-line)] px-1.5 py-0.5">
          {t}
        </span>
      ))}
    </div>
  </div>
);

const Pipeline = () => (
  <div class="flex flex-col md:flex-row md:items-stretch gap-3 md:gap-2">
    {PIPELINE.map((step, i) => (
      <>
        <div class="flex-1 min-w-0">
          <StepBox step={step} />
        </div>
        {i < PIPELINE.length - 1 && (
          <div class="flex items-center justify-center text-[var(--color-bone-fade)] py-2 md:py-0 md:px-1">
            <i class="ti ti-chevron-down md:hidden text-base" aria-hidden="true" />
            <i class="ti ti-chevron-right hidden md:inline text-base" aria-hidden="true" />
          </div>
        )}
      </>
    ))}
  </div>
);

// ─── endpoint catalog with snippets ───────────────────────────────────────

type EndpointDoc = {
  method: "GET" | "POST";
  path: string;
  summary: string;
  description: string;
  params?: { name: string; required?: boolean; desc: string }[];
  curl: string;
  ts: string;
  response: string;
};

const ENDPOINTS: EndpointDoc[] = [
  {
    method: "GET",
    path: "/v1/search",
    summary: "Forward search by free text",
    description:
      "BM25-ranked tokenized matches first, trigram fuzzy fallback, unaccent normalization. Multilingual when aliases are loaded — searching 'münchen' returns Munich with a `matched_alias` field showing which language matched.",
    params: [
      { name: "q", required: true, desc: "Free-text query." },
      { name: "limit", desc: "Max results, 1–50. Default 10." },
      { name: "country", desc: "Restrict to one ISO 3166-1 alpha-2." },
      { name: "bbox", desc: "minLng,minLat,maxLng,maxLat envelope." },
      { name: "proximity_lat / proximity_lng", desc: "Bias ranking toward a point and add `distance_km` to results." },
      { name: "prefer_lang", desc: "Localize the returned `name` field if an alias for that language exists." },
      { name: "layers", desc: "Comma-separated subset of `address`,`locality`. Default both." },
    ],
    curl: `curl 'https://geomark.dev/v1/search?q=berlin&limit=5'`,
    ts: `const params = new URLSearchParams({ q: "berlin", limit: "5" });
const res = await fetch(\`https://geomark.dev/v1/search?\${params}\`);
const { features } = await res.json();`,
    response: `{
  "features": [
    {
      "gid": "geonames:2950159",
      "layer": "locality",
      "name": "Berlin",
      "label": "Berlin",
      "latitude": 52.52437,
      "longitude": 13.41053,
      "country_code": "DE",
      "score": 10.07
    }
    // …
  ],
  "total": 5
}`,
  },
  {
    method: "GET",
    path: "/v1/reverse",
    summary: "Search by coordinates",
    description:
      "Find the nearest places + addresses to a point. Results ordered by spheroid distance, capped to `radius` km. Each feature gets a `distance_km` field.",
    params: [
      { name: "lat", required: true, desc: "Latitude in degrees." },
      { name: "lng", required: true, desc: "Longitude in degrees." },
      { name: "radius", desc: "Cap, in km. Default 5." },
      { name: "limit", desc: "Max results, 1–50. Default 10." },
      { name: "layers", desc: "Comma-separated subset of `address`,`locality`. Default both." },
    ],
    curl: `curl 'https://geomark.dev/v1/reverse?lat=52.52&lng=13.41&radius=5'`,
    ts: `const params = new URLSearchParams({
  lat: "52.52", lng: "13.41", radius: "5",
});
const res = await fetch(\`https://geomark.dev/v1/reverse?\${params}\`);
const { features } = await res.json();`,
    response: `{
  "features": [
    {
      "gid": "geonames:6545310",
      "layer": "locality",
      "name": "Mitte",
      "latitude": 52.520,
      "longitude": 13.405,
      "country_code": "DE",
      "score": 0.93,
      "distance_km": 0.346
    }
    // …
  ],
  "total": 6
}`,
  },
  {
    method: "POST",
    path: "/v1/batch",
    summary: "Batch search/reverse",
    description:
      "Up to 100 search or reverse queries in one request. Per-entry errors return an empty feature list for that slot — the call as a whole still succeeds. For high-volume offline workloads, consider pulling the raw datasets at geomark.dev/data instead.",
    curl: `curl -X POST 'https://geomark.dev/v1/batch' \\
  -H 'Content-Type: application/json' \\
  -d '{
    "entries": [
      { "type": "search",  "q": "berlin", "limit": 1 },
      { "type": "reverse", "lat": 52.52, "lng": 13.41, "limit": 1 }
    ]
  }'`,
    ts: `const res = await fetch("https://geomark.dev/v1/batch", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    entries: [
      { type: "search",  q: "berlin", limit: 1 },
      { type: "reverse", lat: 52.52, lng: 13.41, limit: 1 },
    ],
  }),
});
const { results } = await res.json();`,
    response: `{
  "results": [
    { "features": [{ "name": "Berlin", /* … */ }] },
    { "features": [{ "name": "Mitte",  /* … */ }] }
  ]
}`,
  },
  {
    method: "GET",
    path: "/v1/place/{gid}",
    summary: "Get place by ID",
    description:
      "Returns a single place plus its `aliases` (alternate names by language, IATA/ICAO codes, Wikipedia URL, postal variants). Aliases is empty when the dataset has no aliases artefact. Global ID format: `geonames:<geonameid>`.",
    curl: `curl 'https://geomark.dev/v1/place/geonames:2950159'`,
    ts: `const res = await fetch(
  "https://geomark.dev/v1/place/geonames:2950159",
);
const { place, aliases } = await res.json();`,
    response: `{
  "place": {
    "gid": "geonames:2950159",
    "name": "Berlin",
    "country_code": "DE",
    "population": 3645000,
    "timezone": "Europe/Berlin",
    "latitude": 52.52,
    "longitude": 13.41
  },
  "aliases": [
    { "kind": "name", "lang": "de",   "value": "Berlin",    "is_preferred": true  },
    { "kind": "iata", "lang": null,   "value": "BER",       "is_preferred": false },
    { "kind": "link", "lang": null,   "value": "https://…", "is_preferred": false }
  ]
}`,
  },
  {
    method: "GET",
    path: "/v1/code/{kind}/{value}",
    summary: "Lookup by alternate code",
    description:
      "Find a place via an alternate code. Common kinds: `iata`, `icao`, `faac` (airport codes), `abbr` (e.g. NYC), `wkdt` (Wikidata id), `name` (alternate names — may be ambiguous), `post` (postal variant). Case-insensitive on `value`. Requires the aliases dataset.",
    curl: `curl 'https://geomark.dev/v1/code/iata/MUC'`,
    ts: `const res = await fetch(
  "https://geomark.dev/v1/code/iata/MUC",
);
if (res.status === 404) return null;
const place = await res.json();`,
    response: `{
  "gid": "geonames:2867714",
  "name": "Munich",
  "country_code": "DE",
  "population": 1260391,
  "timezone": "Europe/Berlin",
  "latitude": 48.137,
  "longitude": 11.575
}`,
  },
  {
    method: "GET",
    path: "/v1/postal",
    summary: "Query postal codes",
    description:
      "Filter by `code` (exact), `place` (fuzzy match), and/or `country`. At least one of `code` or `place` is required.",
    params: [
      { name: "code", desc: "Exact postal code match." },
      { name: "place", desc: "Fuzzy match on the associated place name." },
      { name: "country", desc: "Restrict to one ISO 3166-1 alpha-2." },
      { name: "limit", desc: "Max results, 1–100. Default 20." },
    ],
    curl: `curl 'https://geomark.dev/v1/postal?code=10115'`,
    ts: `const params = new URLSearchParams({ code: "10115" });
const res = await fetch(\`https://geomark.dev/v1/postal?\${params}\`);
const { postal_codes } = await res.json();`,
    response: `{
  "postal_codes": [
    {
      "country_code": "DE",
      "postal_code": "10115",
      "place_name": "Berlin",
      "admin_name1": "Berlin",
      "latitude": 52.5323,
      "longitude": 13.3846
    }
  ],
  "total": 1
}`,
  },
  {
    method: "GET",
    path: "/v1/countries",
    summary: "List countries",
    description:
      "All countries known to the dataset, with metadata and a `place_count` of associated places.",
    curl: `curl 'https://geomark.dev/v1/countries'`,
    ts: `const res = await fetch("https://geomark.dev/v1/countries");
const { countries, total } = await res.json();`,
    response: `{
  "total": 252,
  "countries": [
    {
      "code": "DE",
      "code3": "DEU",
      "name": "Germany",
      "capital": "Berlin",
      "continent": "EU",
      "currency_code": "EUR",
      "languages": ["de"],
      "place_count": 4163
    }
    // …
  ]
}`,
  },
  {
    method: "GET",
    path: "/v1/countries/{code}",
    summary: "Get country",
    description:
      "Country metadata for a single 2-letter ISO 3166-1 alpha-2 code. Case-insensitive on the path parameter.",
    curl: `curl 'https://geomark.dev/v1/countries/de'`,
    ts: `const res = await fetch("https://geomark.dev/v1/countries/de");
if (res.status === 404) return null;
const country = await res.json();`,
    response: `{
  "code": "DE",
  "code3": "DEU",
  "name": "Germany",
  "capital": "Berlin",
  "continent": "EU",
  "currency_code": "EUR",
  "languages": ["de"],
  "place_count": 4163
}`,
  },
  {
    method: "GET",
    path: "/v1/coverage",
    summary: "Coverage map",
    description:
      "Per-country deepest available data layer: `address`, `place_only`, or `none`.",
    curl: `curl 'https://geomark.dev/v1/coverage'`,
    ts: `const res = await fetch("https://geomark.dev/v1/coverage");
const { countries } = await res.json();
// countries["DE"] === "address"`,
    response: `{
  "countries": {
    "DE": "address",
    "US": "address",
    "FR": "place_only",
    "XK": "none"
    // …
  }
}`,
  },
  {
    method: "GET",
    path: "/v1/random",
    summary: "Random sample",
    description:
      "Up to 5000 random places. Useful for visualisations, sampling, and dataset exploration. Filter by `country` and/or `min_population`. The hosted API serves this from an indexed sample path with a short shared cache.",
    params: [
      { name: "limit", desc: "How many places, 1–5000. Default 500." },
      { name: "country", desc: "Restrict to one ISO 3166-1 alpha-2." },
      { name: "min_population", desc: "Only places with population ≥ this value." },
    ],
    curl: `curl 'https://geomark.dev/v1/random?limit=500&min_population=1000000'`,
    ts: `const params = new URLSearchParams({
  limit: "500",
  min_population: "1000000",
});
const res = await fetch(\`https://geomark.dev/v1/random?\${params}\`);
const { places } = await res.json();`,
    response: `{
  "total": 500,
  "places": [
    {
      "gid": "geonames:2867714",
      "name": "Munich",
      "country_code": "DE",
      "population": 1260391,
      "latitude": 48.137,
      "longitude": 11.575
    }
    // …
  ]
}`,
  },
  {
    method: "GET",
    path: "/v1/attribution",
    summary: "Data sources & licenses",
    description:
      "Required reading if you redistribute Geomark output. Lists every upstream data source, its license, and a ready-to-paste attribution string.",
    curl: `curl 'https://geomark.dev/v1/attribution'`,
    ts: `const res = await fetch("https://geomark.dev/v1/attribution");
const { data_sources, api_license, notice } = await res.json();`,
    response: `{
  "data_sources": [
    {
      "name": "GeoNames",
      "url": "https://www.geonames.org/",
      "license": "CC BY 4.0",
      "license_url": "https://creativecommons.org/licenses/by/4.0/",
      "used_for": ["places", "postal_codes", "countries", "aliases"],
      "attribution_text": "Source: GeoNames — https://www.geonames.org/ (CC BY 4.0)"
    }
    // …
  ],
  "api_license": { "name": "MIT", "url": "https://opensource.org/licenses/MIT" },
  "notice": "Geomark redistributes derived data from the upstream sources above and is bound by their licenses. Downstream consumers must keep the attribution intact when republishing."
}`,
  },
];

// ─── snippet block (renders both langs, CSS hides the inactive one) ──────

const SnippetBlock = (p: {
  icon: string;
  label: string;
  lang: "curl" | "ts" | "json";
  code: string;
}) => (
  <div>
    <div class="flex items-baseline justify-between gap-3 mb-2">
      <span class="mono-cap flex items-center gap-2">
        <i class={`ti ${p.icon}`} aria-hidden="true" /> {p.label}
      </span>
      <CopyButton text={p.code} />
    </div>
    <pre class="code-block overflow-x-auto">
      <Code lang={p.lang} code={p.code} />
    </pre>
  </div>
);

const Snippet = (p: { d: EndpointDoc }) => (
  <div class="space-y-3">
    <div data-lang="curl">
      <SnippetBlock
        icon="ti-terminal-2"
        label="request · curl"
        lang="curl"
        code={p.d.curl}
      />
    </div>
    <div data-lang="ts">
      <SnippetBlock
        icon="ti-brand-typescript"
        label="request · typescript"
        lang="ts"
        code={p.d.ts}
      />
    </div>
    <SnippetBlock
      icon="ti-braces"
      label="response · 200 OK"
      lang="json"
      code={p.d.response}
    />
  </div>
);

const EndpointBlock = (p: { d: EndpointDoc }) => (
  <article class="panel">
    <header class="flex items-baseline gap-3 flex-wrap mb-3">
      <span
        class={`font-mono text-xs tracking-widest font-medium ${p.d.method === "POST" ? "text-[var(--color-marker)]" : "text-[var(--color-tide)]"}`}
      >
        {p.d.method}
      </span>
      <code class="font-mono text-base md:text-lg text-[var(--color-bone)]">
        {p.d.path}
      </code>
      <span class="coord text-[var(--color-bone-fade)] ml-auto">{p.d.summary}</span>
    </header>

    <p class="text-sm text-[var(--color-bone-dim)] leading-relaxed mb-5">
      {p.d.description}
    </p>

    {p.d.params && p.d.params.length > 0 && (
      <div class="mb-5">
        <span class="mono-cap mb-2 block">parameters</span>
        <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          {p.d.params.map((param) => (
            <>
              <dt class="font-mono text-[13px] text-[var(--color-bone)]">
                {param.name}
                {param.required ? <span class="text-[var(--color-marker)]"> *</span> : null}
              </dt>
              <dd class="text-[var(--color-bone-dim)]">{param.desc}</dd>
            </>
          ))}
        </dl>
      </div>
    )}

    <Snippet d={p.d} />
  </article>
);

// ─── self-deploy quick start ─────────────────────────────────────────────

const QUICK_START = `# 1. clone the repo
$ git clone https://github.com/valentinkolb/geomark
$ cd geomark

# 2. set the OpenAddresses bundle URL (required)
$ echo 'OPENADDRESSES_URL=https://your-bundle-host/oa.zip' > .env

# 3. boot
$ docker compose up -d

# 4. wait for /ready (loader downloads ~210k places, ~1.5M postal codes)
$ curl http://localhost:4000/ready
$ curl http://localhost:4000/v1/search -G --data-urlencode 'q=berlin'`;

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

// ─── page ─────────────────────────────────────────────────────────────────

export default ssr(async (c) => {
  const page = c.get("page");
  page.title = "Geomark — docs";
  page.description =
    "How Geomark works, full API reference with curl + TypeScript examples, and self-deploy instructions.";

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
            <a href="/data" class="text-[var(--color-bone-dim)] hover:text-[var(--color-marker)]">data</a>
            <a href="/docs" class="text-[var(--color-marker)]">docs</a>
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

      {/* content with lang-toggle root */}
      <div
        data-lang-root
        class="lang-curl relative z-10 max-w-[1280px] mx-auto px-4 md:px-6 pt-20 md:pt-24 pb-24"
      >

        {/* ─── PAGE HEADER ──────────────────────────────────────────────── */}
        <header class="mb-16 md:mb-24 max-w-3xl pt-6 md:pt-10">
          <div class="mono-cap mb-4 flex items-center gap-2">
            <i class="ti ti-book" aria-hidden="true" /> documentation
          </div>
          <h1 class="display text-[clamp(2.25rem,6vw,4.5rem)] mb-5 md:mb-6">
            How <span class="display-italic text-[var(--color-marker)]">Geomark</span>{" "}
            works.
          </h1>
          <p class="text-base md:text-lg text-[var(--color-bone)]/85 leading-relaxed">
            What's behind the API, every endpoint with copyable examples, and
            how to run the whole stack on your own infrastructure.
          </p>
        </header>

        {/* ─── 1. HOW IT WORKS ─────────────────────────────────────────── */}
        <section class="mb-20 md:mb-28">
          <SectionLabel label="How it works" coord="upstream → loader → db → api" icon="ti-affiliate" />

          <div class="grid md:grid-cols-12 gap-6 md:gap-10 mb-10 md:mb-12">
            <div class="md:col-span-7 space-y-4 text-[var(--color-bone-dim)] leading-relaxed">
              <p>
                Geomark is a thin layer on top of two open datasets. The data
                loader downloads them, parses them into a consistent CSV
                layout, and serves them to the API. The API ingests on every
                refresh — atomically, so queries never see a half-loaded
                dataset.
              </p>
              <p>
                Forward search runs a hybrid ranker: tokenized BM25 first,
                trigram fuzzy as a fallback for typos, all normalized with
                <code class="code-inline">unaccent</code> so umlauts and
                diacritics are optional. When the aliases dataset is loaded,
                queries also match across alternate names — searching{" "}
                <code class="code-inline">münchen</code> finds Munich, with a{" "}
                <code class="code-inline">matched_alias</code> field on the
                result so you can show <em>why</em> it matched.
              </p>
              <p>
                Reverse lookup uses a PostGIS GiST spatial index, prefiltered
                by a per-axis bounding box (latitude scale stays constant,
                longitude scale gets the cosine correction so high-latitude
                queries don't clip).
              </p>
            </div>

            <div class="md:col-span-5 panel-tight space-y-3">
              <div class="mono-cap flex items-center gap-2">
                <i class="ti ti-license" aria-hidden="true" /> attribution
              </div>
              <p class="text-sm text-[var(--color-bone-dim)] leading-relaxed">
                The places, postal codes, country metadata, and aliases come
                from{" "}
                <a
                  href="https://www.geonames.org/"
                  class="text-[var(--color-bone)] hover:text-[var(--color-marker)] underline-offset-4 hover:underline"
                >
                  GeoNames.org
                </a>{" "}
                under{" "}
                <a
                  href="https://creativecommons.org/licenses/by/4.0/"
                  class="text-[var(--color-bone)] hover:text-[var(--color-marker)] underline-offset-4 hover:underline"
                >
                  CC&nbsp;BY&nbsp;4.0
                </a>
                . Their dataset is what makes this whole thing possible.
              </p>
              <p class="text-sm text-[var(--color-bone-dim)] leading-relaxed">
                Addresses come from{" "}
                <a
                  href="https://openaddresses.io/"
                  class="text-[var(--color-bone)] hover:text-[var(--color-marker)] underline-offset-4 hover:underline"
                >
                  OpenAddresses
                </a>{" "}
                contributors, with per-source licenses (CC0, CC BY, ODbL,
                public domain).
              </p>
              <p class="text-sm text-[var(--color-bone-dim)] leading-relaxed">
                If you redistribute results, keep the credit lines from{" "}
                <a href="#endpoint-attribution" class="coord-tide hover:underline">
                  /v1/attribution
                </a>{" "}
                intact.
              </p>
            </div>
          </div>

          {/* Pipeline */}
          <div class="mb-3">
            <span class="mono-cap flex items-center gap-2">
              <i class="ti ti-route" aria-hidden="true" /> pipeline
            </span>
          </div>
          <Pipeline />
        </section>

        {/* ─── 2. API REFERENCE ─────────────────────────────────────────── */}
        <section class="mb-20 md:mb-28">
          <SectionLabel
            label="API reference"
            coord="11 routes · prefix /v1"
            icon="ti-api"
          />

          <p class="text-sm text-[var(--color-bone-dim)] leading-relaxed mb-3 max-w-2xl">
            <code class="code-inline">/health</code> and{" "}
            <code class="code-inline">/ready</code> are mounted at the API
            root (not under <code class="code-inline">/v1</code>) so
            probes bypass auth and rate limiting. The OpenAPI spec is at{" "}
            <code class="code-inline">/v1/openapi.json</code>; Scalar
            UI at <code class="code-inline">/v1/docs</code>.
          </p>

          <div class="flex items-baseline justify-between flex-wrap gap-4 mb-8">
            <p class="text-sm text-[var(--color-bone-dim)] leading-relaxed max-w-2xl">
              Every route returns JSON. Errors share the shape{" "}
              <code class="code-inline">{"{ error, code }"}</code>. Hosted at
              {" "}
              <code class="code-inline">geomark.dev</code> · self-hosted at
              your own host. Pick a language for the snippets:
            </p>
            <LangToggle />
          </div>

          <div class="space-y-5 md:space-y-6">
            {ENDPOINTS.map((d) => (
              <EndpointBlock d={d} />
            ))}
          </div>
        </section>

        {/* ─── 3. SELF-DEPLOY ──────────────────────────────────────────── */}
        <section class="mb-20 md:mb-28">
          <SectionLabel label="Self-deploy" coord="docker compose" icon="ti-server-bolt" />

          <p class="text-base md:text-lg text-[var(--color-bone)]/90 leading-relaxed mb-8 max-w-2xl">
            Four containers, one compose file: PostgreSQL + PostGIS for
            storage (<code class="code-inline">db</code>), the data loader
            for ingestion (<code class="code-inline">data</code>), the API
            for queries (<code class="code-inline">api</code>), and the
            geomark.dev landing page (<code class="code-inline">web</code>) —
            the last is optional, drop it from the compose file if you
            only want the API surface.
          </p>

          {/* Quick start */}
          <div class="panel mb-6 md:mb-8">
            <SnippetBlock
              icon="ti-play"
              label="quick start"
              lang="curl"
              code={QUICK_START}
            />
          </div>

          {/* Env vars */}
          <div class="panel mb-6 md:mb-8">
            <div class="mono-cap mb-4 flex items-center gap-2">
              <i class="ti ti-settings" aria-hidden="true" /> environment
            </div>
            <dl class="grid grid-cols-1 md:grid-cols-[220px_1fr] gap-x-6 gap-y-3 text-sm">
              {[
                ["API_KEY", "If set, bearer-auth is enforced on /v1/*. /health and /ready stay open."],
                ["REDIS_URL", "Optional Redis URL. Compose sets it automatically for distributed rate limiting and shared response caches."],
                ["RATELIMIT_PER_MINUTE", "Per-IP sliding-window rate limit. Default 60. Redis-backed when REDIS_URL is set."],
                ["RANDOM_CACHE_SECONDS", "Shared TTL for /v1/random responses. Default 10; set 0 to disable."],
                ["REFERENCE_CACHE_SECONDS", "Shared TTL for stable reference endpoints such as countries and coverage. Default 300; set 0 to disable."],
                ["TRUSTED_PROXY_HOPS", "Number of X-Forwarded-For hops to trust. 0 for direct, 1 behind a single reverse proxy."],
                ["OPENADDRESSES_URL", "Required. URL of an OpenAddresses bundle ZIP."],
                ["POSTGRES_PASSWORD", "Required by compose.prod.yml. Set a strong value before public deployment."],
                ["GEONAMES_CITIES_URL", "Override for smaller subsets. Default: cities500.zip from GeoNames."],
                ["GEONAMES_POSTAL_URL", "Override for per-country postal codes. Default: allCountries.zip."],
                ["GEONAMES_ALIASES_URL", "Optional. When set, the loader also ingests alternateNamesV2 (multilingual aliases + IATA/ICAO/Wikipedia)."],
                ["REFRESH_INTERVAL_DAYS", "How often the loader re-checks upstream sources. Default 30."],
              ].map(([key, desc]) => (
                <>
                  <dt class="font-mono text-[13px] text-[var(--color-bone)] break-words">{key}</dt>
                  <dd class="text-[var(--color-bone-dim)] leading-relaxed">{desc}</dd>
                </>
              ))}
            </dl>
          </div>

          {/* Production notes */}
          <div class="panel">
            <div class="mono-cap mb-4 flex items-center gap-2">
              <i class="ti ti-shield-check" aria-hidden="true" /> production checklist
            </div>
            <ul class="space-y-3 text-sm text-[var(--color-bone-dim)] leading-relaxed">
              {[
                ["Bearer auth", "Set API_KEY. The /v1/* routes will require Authorization: Bearer <key>; /health and /ready stay public for probes."],
                ["Rate limit", "Default is 60/min/IP. Bump RATELIMIT_PER_MINUTE for trusted internal traffic, drop it for public exposure."],
                ["Reverse proxy", "Behind Traefik or nginx, set TRUSTED_PROXY_HOPS=1 so the rate limiter sees the real client IP via X-Forwarded-For."],
                ["TLS", "Terminate at the proxy. The container speaks plain HTTP on its internal port."],
                ["Production compose", "Use compose.prod.yml for Traefik. It routes geomark.dev/v1/* directly to api and keeps metrics disabled unless METRICS_ENABLED=true."],
                ["Postgres", "The compose file uses TimescaleDB-HA which bundles the required extensions. If you're bringing your own Postgres, install PostGIS, pg_trgm, unaccent, and pg_textsearch."],
                ["Storage", "Mount geomark-db and geomark-data volumes if you don't want to re-download upstream sources on every container recreate."],
                ["Updates", "REFRESH_INTERVAL_DAYS controls re-ingestion cadence. Default 30 days. The loader runs in-place; the API atomically swaps to the new dataset when ready."],
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
