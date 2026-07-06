# Geomark

A geocoding API for places, addresses, and postal codes. Forward search,
reverse lookup, multilingual aliases, fuzzy matching.

Run it on your own infrastructure with the open-source binary, or use the free
hosted version at **[geomark.dev](https://geomark.dev)**.

---

## Endpoints

All routes are mounted under `/v1/*` and return JSON. Errors share the
shape `{ error, code }`. Full schemas, parameters, and examples live in the
OpenAPI spec at `/v1/openapi.json` (Scalar UI at `/v1/docs`).

| Method | Path | Description |
|---|---|---|
| `GET`  | `/v1/search`              | Forward search by free text. BM25 ranking, trigram fuzzy, unaccent. |
| `GET`  | `/v1/reverse`             | Coordinates → places, ordered by distance, bounded by radius. |
| `POST` | `/v1/batch`               | Up to 100 search or reverse queries in one request. |
| `GET`  | `/v1/place/{gid}`         | Place by ID, with all aliases (alternate names, IATA/ICAO, links). |
| `GET`  | `/v1/code/{kind}/{value}` | Lookup by alternate code: IATA, ICAO, Wikidata, postal variant. |
| `GET`  | `/v1/postal`              | Postal codes by code, place name, or country. |
| `GET`  | `/v1/countries`           | Country list with metadata and place counts. |
| `GET`  | `/v1/countries/{code}`    | Country metadata for a 2-letter ISO 3166-1 alpha-2 code. |
| `GET`  | `/v1/coverage`            | Per-country deepest available data layer (`address` / `place_only` / `none`). |
| `GET`  | `/v1/attribution`         | Data sources, licenses, attribution strings. |
| `GET`  | `/v1/random`              | Up to 5000 random places. Filter by country or `min_population`. |

---

## Hosted

```sh
curl https://geomark.dev/v1/search -G --data-urlencode 'q=berlin'
```

- Free, no signup
- Rate-limited per IP
- Same code as the open-source binary

---

## Self-host

Five containers behind one compose file: PostgreSQL + PostGIS (`db`), Redis
(`redis`), the data loader (`data`), the API (`api`), and the geomark.dev
landing page (`web`). The loader downloads upstream sources on first start and
the API picks them up automatically.

```sh
git clone https://github.com/valentinkolb/geomark
cd geomark

# Required: point the data loader at an OpenAddresses bundle
echo 'OPENADDRESSES_URL=https://your-host/oa.zip' > .env

docker compose up -d
```

The first start takes a few minutes — the data loader needs to download and
ingest GeoNames + OpenAddresses. Watch `/ready` for status:

```sh
curl http://localhost:4000/ready
# {"status":"loading", ...}  → still ingesting
# {"status":"ready",   ...}  → ready to query
```

For a public Traefik deployment, use `compose.prod.yml`. It pulls published
GHCR images instead of building local source, requires an explicit image tag
(`GEOMARK_VERSION`), and keeps durable state in the `geomark-db` and
`geomark-data` Docker volumes.

```sh
cp .env.prod.example .env.prod
# edit GEOMARK_VERSION, DOMAIN, POSTGRES_PASSWORD, OPENADDRESSES_URL

docker compose --env-file .env.prod -f compose.prod.yml pull
docker compose --env-file .env.prod -f compose.prod.yml up -d
```

Production compose expects an external Traefik network. It routes the apex
site to `web`, `api.<DOMAIN>` plus apex `/v1/*` to `api`, and
`data.<DOMAIN>` to `data`.

### Configuration

The full env surface is documented per package
([api](./packages/api/README.md), [data](./packages/data/README.md),
[web](./packages/web/README.md)). The most relevant for self-hosters:

| Variable | Default | Description |
|---|---|---|
| `GEOMARK_VERSION` | (required in prod) | Published GHCR tag for `geomark-api`, `geomark-data`, and `geomark-web`. |
| `DOMAIN` | (required in prod) | Public apex domain used by Traefik labels and public data links. |
| `POSTGRES_PASSWORD` | (required in prod) | Password for the bundled Postgres service. |
| `API_KEY` | (none) | If set, bearer-auth is enforced on all `/v1/*` routes. |
| `REDIS_URL` | `redis://redis:6379` in compose | Native Bun Redis backend for distributed rate limiting and shared short-lived API caches. |
| `RATELIMIT_PER_MINUTE` | `60` | Per-IP rate limit. Redis-backed in compose, in-memory fallback otherwise. |
| `RANDOM_CACHE_SECONDS` | `10` | Shared TTL for `/v1/random`, including the homepage showcase sample. |
| `REFERENCE_CACHE_SECONDS` | `300` | Shared TTL for stable reference endpoints such as countries and coverage. |
| `OPENADDRESSES_URL` | (required) | URL of an OpenAddresses bundle ZIP for the data loader. |
| `GEONAMES_ALIASES_URL` | (none) | Optional. When set, multilingual aliases are loaded too. |
| `METRICS_ENABLED` | `true` | Prometheus scrape endpoint + RED middleware. Set `false` to disable. |
| `METRICS_TOKEN` | (none) | Bearer token for `/metrics`. Falls back to `API_KEY` if unset; both unset → open. |
| `METRICS_PATH` | `/metrics` | Path for the scrape endpoint. |

---

## Data

| Source | Used for | License |
|---|---|---|
| [GeoNames](https://www.geonames.org/)     | places, postal codes, countries, aliases | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| [OpenAddresses](https://openaddresses.io/) | addresses                                 | mixed per-source (CC0, CC BY, ODbL, public domain)        |

The dataset is rebuilt monthly. Raw compressed CSV bundles are available at
[geomark.dev/data](https://geomark.dev/data) — pull them directly if you'd
rather query locally than hit the API.

When redistributing Geomark output, keep the credit lines from
`GET /v1/attribution` intact. The license obligations come from the
upstream sources.

---

## Stack

| Layer | Technology |
|---|---|
| API runtime  | Hono on Bun. Single binary, no Node toolchain. |
| Database     | PostgreSQL 17 + PostGIS + pg_trgm + unaccent + pg_textsearch |
| Search rank  | BM25 with trigram fuzzy fallback, unaccent normalization |
| Reverse      | GiST spatial index, ST_DistanceSphere, per-axis bbox prefilter |
| Aliases      | Joined alias table — ranks across all language names, returns `matched_alias` on results that ranked via aliases |
| Web (geomark.dev) | Hono + Solid (SSR + islands), Tailwind v4, Tabler icons |

---

## Repository

```
packages/
├── api/      Hono server, routes, service layer, migrations, tests
├── data/     Data loader (downloads + parses GeoNames + OpenAddresses → CSV)
├── shared/   Zod schemas + TypeScript types shared between api and web
└── web/      geomark.dev — landing page, docs, live API showcase
```

Each package has its own README with setup notes.

---

## License

MIT for the code (see [LICENSE](./LICENSE)). Data is redistributed under the
upstream licenses listed at `/v1/attribution` (primarily GeoNames under
CC BY 4.0). Downstream redistributors must preserve the upstream attribution.
