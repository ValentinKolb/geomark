# @geomark/api

Hono server for the Geomark API. Mounts under `/v1/*` and exposes the
routes documented in the [root README](../../README.md#endpoints).

## Run

```sh
bun run dev        # NODE_ENV=development, --watch, rebuilds on save
bun run start      # production
bun run test       # sequential test runner (per-file Postgres containers)
bun run typecheck  # tsc --noEmit on src/ and tests/
```

## Environment

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL`         | (required)         | Postgres connection string. The schema must include PostGIS, pg_trgm, unaccent, and pg_textsearch — the migration creates them with `CREATE EXTENSION IF NOT EXISTS`. |
| `DATA_URL`             | `http://data:3000` | Where to fetch the dataset bundle from. The compose default points at the data builder service. |
| `PORT`                 | `3000`             | HTTP port to listen on. |
| `API_KEY`              | (none)             | If set, bearer-auth is enforced on all `/v1/*` routes. `/health` and `/ready` stay open. |
| `RATELIMIT_PER_MINUTE` | `60`               | Per-IP sliding-window rate limit. |
| `TRUSTED_PROXY_HOPS`   | `1`                | Number of `X-Forwarded-For` hops to trust when extracting client IPs. `1` matches the typical "behind one reverse proxy" setup; set to `0` for direct exposure. |
| `REFRESH_INTERVAL_HOURS` | `6`              | How often the API polls the data builder's manifest for a new dataset version. Distinct from `REFRESH_INTERVAL_DAYS` in the data package, which controls upstream re-download cadence. |
| `LOAD_ONCE`            | (unset)            | If set to `1`, the API ingests once and skips the periodic refresh loop. Useful in tests. |
| `METRICS_ENABLED`      | `true`             | Mounts the `/metrics` Prometheus scrape endpoint and the HTTP RED middleware on `/v1/*`. The metrics registry itself is always built (zero cost when unscraped) so loader gauges stay valid. |
| `METRICS_TOKEN`        | (none)             | Bearer token for `/metrics`. Layered fallback: if unset and `API_KEY` is set, the API key gates `/metrics` too. Both unset → open mode (intended for trusted internal networks). Constant-time compare against the provided token. |
| `METRICS_PATH`         | `/metrics`         | Path for the scrape endpoint. Override only if your gateway needs something exotic. |

### Metrics surface

Standard `process_*` + `nodejs_*` runtime metrics from `prom-client`'s
default collector, plus the Geomark-specific series:

| Metric | Type | Labels | Use |
|---|---|---|---|
| `geomark_http_requests_total` | counter | `route`, `status_class` | Request rate, error rate (RED's R + E) |
| `geomark_http_request_duration_seconds` | histogram | `route` | Latency p50/p95/p99 (RED's D) |
| `geomark_http_in_flight` | gauge | — | Concurrent in-flight requests |
| `geomark_places_total`, `_addresses_total`, `_postal_codes_total`, `_aliases_total` | gauge | — | Live row counts in the loaded dataset |
| `geomark_dataset_version_info` | gauge | `version` | Always 1; version carried in label (rotates cleanly) |
| `geomark_dataset_loaded_at_seconds` | gauge | — | Unix timestamp of last successful load |
| `geomark_dataset_loads_total` | counter | `result` (`success`/`error`/`skipped_unchanged`) | Loader run outcomes |
| `geomark_loader_duration_seconds` | histogram | `stage` (`ingest`/`refresh`) | Loader runtime per stage |
| `geomark_ratelimit_rejected_total` | counter | — | Requests dropped by the per-IP limiter |
| `geomark_auth_rejected_total` | counter | `reason` (`missing`/`malformed`/`invalid`) | Bearer-auth rejections |
| `geomark_build_info` | gauge | `version`, `commit` | Build provenance (value=1) |

Cardinality is bounded by design — `route` is the matched template
(`/v1/place/{gid}`, never the actual GID), `status_class` is
`2xx`/`3xx`/`4xx`/`5xx`/`other`, all enum-typed labels are fixed
small sets. Safe to scrape at 15s intervals indefinitely.

The full self-host setup including the data loader and database is in
[`compose.yml`](../../compose.yml).

## Structure

```
src/
├── app.ts              Hono factory: middleware, routes, error handlers, OpenAPI spec
├── index.ts            Executable entrypoint — runs migrations, starts loader, signal handlers
├── migrate.ts          DDL: tables, indexes, generated columns
├── config.ts           Env parsing and defaults
├── attribution.ts      Static attribution metadata for /v1/attribution
├── routes/             Route handlers (one Hono chain that composes onto /v1)
├── service/            Business logic — search, reverse, postal, countries, coverage, batch, code, places, random
├── loader/             Reads the data builder bundle, ingests into Postgres atomically
└── lib/                Shared helpers: respond/Result type (respond.ts), ratelimit.ts, csv.ts, streams.ts
```

## Tests

Each test file spawns its own ephemeral Postgres container (the
TimescaleDB-HA image bundles PostGIS + the required extensions) and runs in
isolation. The orchestrator at `tests/run.ts` runs them sequentially to avoid
container-startup contention on the host.

```sh
bun run test          # fail-fast, runs each file once
bun tests/run.ts --all  # opt-in to run every file even after a failure
```

Test infrastructure lives in `tests/lib/`:
- `testdb.ts` — spawns a container, waits for readiness, registers exit hooks
- `seed.ts`   — fakes the data builder by serving canned CSV bundles over HTTP
- `fixtures.ts` — the canned datasets (places, addresses, postal, aliases)
