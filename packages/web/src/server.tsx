import { Hono, type Context } from "hono";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import tailwindPlugin from "bun-plugin-tailwind";
import { config as ssrConfig, routes } from "../config";
import { config } from "./config";
import Home from "./pages/Home";
import Docs from "./pages/Docs";
import Data from "./pages/Data";
import Impressum from "./pages/Impressum";

console.log(`[geomark/web] env=${process.env.NODE_ENV ?? "dev"} api=${config.apiUrl}`);

// ─── compile styles + font assets at boot ─────────────────────────────────
// `bun-plugin-tailwind` processes our styles.css and follows the @import
// chain (incl. @tabler/icons-webfont). Bun.build emits the CSS plus every
// referenced asset (woff2 / woff / ttf …) as separate outputs; we keep
// them in memory and serve them by basename so the rewritten font URLs in
// the CSS resolve at /tabler-icons-<hash>.woff2 etc.
type Asset = { content: ArrayBuffer; type: string };
const assets = new Map<string, Asset>();

const stylesPath = new URL("./styles.css", import.meta.url).pathname;
const build = await Bun.build({
  entrypoints: [stylesPath],
  plugins: [tailwindPlugin],
  minify: process.env.NODE_ENV === "production",
});
if (!build.success) {
  console.error("[geomark/web] CSS build failed:");
  for (const m of build.logs) console.error(m);
} else {
  for (const out of build.outputs) {
    const base = out.path.split("/").pop()!;
    assets.set(base, {
      content: await out.arrayBuffer(),
      type: out.type || "application/octet-stream",
    });
  }
  console.log(
    `[geomark/web] built ${assets.size} asset(s): ${[...assets.keys()].join(", ")}`,
  );
}

// ─── app ──────────────────────────────────────────────────────────────────
const app = new Hono()
  .use(logger())
  .use(
    "*",
    secureHeaders({
      xFrameOptions: "DENY",
      xContentTypeOptions: "nosniff",
      referrerPolicy: "strict-origin-when-cross-origin",
    }),
  )
  .route("/_ssr", routes(ssrConfig));

// One static route per emitted asset (CSS, fonts). Long-cache everything
// except styles.css in dev (where edits should reload instantly).
for (const [name, a] of assets) {
  const cacheControl =
    name === "styles.css" && process.env.NODE_ENV !== "production"
      ? "no-store"
      : "public, max-age=31536000, immutable";
  app.get(`/${name}`, () =>
    new Response(a.content, {
      headers: { "Content-Type": a.type, "Cache-Control": cacheControl },
    }),
  );
}

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
]);

const forwardHeaders = (headers: Headers): Headers => {
  const out = new Headers(headers);
  for (const h of HOP_BY_HOP_HEADERS) out.delete(h);
  return out;
};

// Same-origin fallback proxy to the Geomark API. Production Traefik routes
// apex /v1/* directly to the API for the fast path; this keeps local compose
// and non-Traefik self-hosting working with the same browser-visible paths.
const proxyToApi = async (c: Context, stripPrefix = "") => {
  const url = new URL(c.req.url);
  const pathname =
    stripPrefix && url.pathname.startsWith(stripPrefix)
      ? (url.pathname.slice(stripPrefix.length) || "/")
      : url.pathname;
  const upstream = `${config.apiUrl}${pathname}${url.search}`;
  const init: RequestInit = {
    method: c.req.method,
    headers: forwardHeaders(c.req.raw.headers),
    body:
      c.req.method === "GET" || c.req.method === "HEAD"
        ? undefined
        : c.req.raw.body,
  };
  try {
    return await fetch(upstream, init);
  } catch {
    return c.json({ error: "service unavailable" }, 503);
  }
};

app.all("/v1/*", (c) => proxyToApi(c));
app.all("/ready", (c) => proxyToApi(c));
app.all("/api/*", (c) => proxyToApi(c, "/api"));

// Crosshair favicon — same registration-mark design as the page cursor,
// thicker stroke + rounded caps so it stays legible at 16×16.
const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <circle cx="16" cy="16" r="10" fill="none" stroke="#FF8A3D" stroke-width="2.5"/>
  <circle cx="16" cy="16" r="2.4" fill="#FF8A3D"/>
  <line x1="16" y1="0"  x2="16" y2="5"  stroke="#FF8A3D" stroke-width="2.5" stroke-linecap="round"/>
  <line x1="16" y1="27" x2="16" y2="32" stroke="#FF8A3D" stroke-width="2.5" stroke-linecap="round"/>
  <line x1="0"  y1="16" x2="5"  y2="16" stroke="#FF8A3D" stroke-width="2.5" stroke-linecap="round"/>
  <line x1="27" y1="16" x2="32" y2="16" stroke="#FF8A3D" stroke-width="2.5" stroke-linecap="round"/>
</svg>`;

app.get("/favicon.svg", () =>
  new Response(FAVICON_SVG, {
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": "public, max-age=86400",
    },
  }),
);

app
  .get("/health", (c) => c.json({ status: "ok" as const }))
  .get("/", ...Home)
  .get("/docs", ...Docs)
  .get("/data", ...Data)
  .get("/impressum", ...Impressum);

const port = Number(process.env.PORT ?? 3000);
console.log(`[geomark/web] http://localhost:${port}`);

export default {
  fetch: app.fetch,
  port,
};
