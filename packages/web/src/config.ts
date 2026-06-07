export const config = {
  apiUrl: process.env.API_URL ?? "http://localhost:4000",
  // Where the data builder serves /v1/latest.json + the /v1/*.csv.zst files.
  // Used for SSR-side manifest fetching on the /data page. Include the /v1
  // schema-version prefix so the page-side code stays prefix-free.
  dataUrl: process.env.DATA_URL ?? "http://localhost:14002/v1",
  // Public (canonical) URL where the dataset bundles are served from.
  // Surfaced in the docs/curl examples so users can copy-paste them
  // straight away. Override when hosting under a different domain.
  dataPublicUrl:
    process.env.DATA_PUBLIC_URL ?? "https://data.geomark.dev/v1",
} as const;
