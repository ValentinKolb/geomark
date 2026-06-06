export const config = {
  apiUrl: process.env.API_URL ?? "http://localhost:4000",
  // Where the data builder serves /latest.json + the *.csv.zst files.
  // Used for SSR-side manifest fetching on the /data page.
  dataUrl: process.env.DATA_URL ?? "http://localhost:14002",
  // Public (canonical) URL where the dataset bundles are served from.
  // Surfaced in the docs/curl examples so users can copy-paste them
  // straight away. Override when hosting under a different domain.
  dataPublicUrl: process.env.DATA_PUBLIC_URL ?? "https://geomark.dev/data",
} as const;
