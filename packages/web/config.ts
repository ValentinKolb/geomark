import { createConfig } from "@valentinkolb/ssr";
import { createSSRHandler, routes } from "@valentinkolb/ssr/hono";

type PageOptions = {
  title?: string;
  description?: string;
};

/**
 * Top-level SSR config (mirrors @valentinkolb/ssr-example).
 *
 * Lives outside `src/` so `rootDir` resolves to the package root and
 * the SSR plugin discovers islands under `src/components/*.island.tsx`.
 */
const cfg = createConfig<PageOptions>({
  dev: process.env.NODE_ENV === "development",
  verbose: false,
  rootDir: import.meta.dir,
  template: ({ body, scripts, title, description }) => `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="color-scheme" content="dark">
    <title>${title ?? "Geomark"}</title>
    <meta name="description" content="${description ?? "Self-hosted geocoding API for places, addresses, and postal codes."}">
    <link rel="icon" type="image/svg+xml" href="/favicon.svg">
    <link rel="stylesheet" href="/styles.css">
  </head>
  <body>
    ${body}
  </body>
  ${scripts}
</html>`,
});

export const { config, plugin } = cfg;
export const ssr = createSSRHandler(cfg.html);
export { routes };
