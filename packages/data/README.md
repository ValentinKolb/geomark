# @geomark/data

Data loader. Downloads upstream sources (GeoNames + OpenAddresses), normalises
them into a consistent CSV layout, compresses with zstd, and serves the
resulting bundle over HTTP for the API to ingest.

## Run

```sh
bun run dev      # downloads + builds, then serves; refreshes on REFRESH_INTERVAL_DAYS
bun run start    # production
```

## Environment

| Variable | Default | Description |
|---|---|---|
| `OUTPUT_DIR`               | `/data`    | Where compressed CSVs are written. The compose volume `geomark-data` is mounted here. |
| `REFRESH_INTERVAL_DAYS`    | `30`       | How often to re-download upstream sources. Long intervals are split into safe timer chunks internally. |
| `OPENADDRESSES_URL`        | (required) | URL of an OpenAddresses bundle ZIP or Batch collection endpoint. Batch Global is `https://batch.openaddresses.io/api/collections/1/data`. |
| `OPENADDRESSES_TOKEN`      | (none)     | Bearer token for authenticated OpenAddresses Batch collection downloads. Store it outside Git and inject it at runtime. |
| `GEONAMES_CITIES_URL`      | `https://download.geonames.org/export/dump/cities500.zip` | Pass any URL ending in a GeoNames cities ZIP filename to override. Use `allCountries.zip` for the largest places dataset. |
| `GEONAMES_POSTAL_URL`      | `https://download.geonames.org/export/zip/allCountries.zip` | Override with a per-country file URL (e.g. `https://download.geonames.org/export/zip/DE.zip`). |
| `GEONAMES_COUNTRY_INFO_URL`| `https://download.geonames.org/export/dump/countryInfo.txt` | Country metadata file. |
| `GEONAMES_ALIASES_URL`     | (none)     | When set, also ingests `alternateNamesV2` for multilingual aliases + IATA/ICAO/Wikipedia codes. |
| `BUILD_ONCE`               | (unset)    | If set to `1`, the loader builds the bundle once and exits. Useful for one-shot CI builds. |

## Output

```
output/
├── latest.json         Version + per-file SHA256 + row counts
├── places.csv.zst      ~210k cities (cities500 default)
├── postal_codes.csv.zst
│                       ~1.5M postal codes (allCountries default)
├── countries.csv.zst   ISO 3166 country metadata
├── addresses-{cc}.csv.zst
│                       OpenAddresses, one file per country. Supports prepared
│                       openaddresses/<cc>.csv ZIPs, legacy global CSV layouts,
│                       and authenticated Batch NDJSON GeoJSON collections.
└── aliases.csv.zst     Optional, only when GEONAMES_ALIASES_URL is set
```

`latest.json` is what the API watches — when its hash changes, the API
re-ingests in the background and atomically swaps the dataset.

## Pipeline

```
download → unzip → parse → transform → zstd → manifest
   │         │       │         │         │
   │         │       │         │         └─ written to OUTPUT_DIR
   │         │       │         └─────────── places: GeoNames TSV → CSV
   │         │       │                      addresses: OpenAddresses CSV → normalised
   │         │       │                      postal: GeoNames TSV → CSV
   │         │       │                      aliases: alternateNamesV2 → kind/lang/value triples
   │         │       └─────────────────── per-source parser
   │         └─────────────────────────── handles ZIP and bare files
   └───────────────────────────────────── HTTP fetch with conditional GET (ETag/If-Modified-Since)
```
