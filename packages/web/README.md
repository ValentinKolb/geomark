# @geomark/web

The geomark.dev landing page. Hono + Solid (SSR + islands) on Bun, Tailwind
CSS v4 via `bun-plugin-tailwind`, Tabler icons via webfont.

## Run

```sh
bun run dev        # NODE_ENV=development, --watch, ssr plugin in preload
bun run build      # production bundle to dist/
bun run start      # production server (NODE_ENV=production bun dist/server.js)
bun run typecheck  # tsc --noEmit
```

## Environment

| Variable | Default | Description |
|---|---|---|
| `PORT`    | `3000`                  | HTTP port. |
| `API_URL` | `http://localhost:4000` | Upstream API used by SSR status fetches and the same-origin fallback proxy for `/v1/*`, `/ready`, and `/api/*`. |
| `DATA_URL` | `http://localhost:14002/v1` | Server-side data manifest URL used by `/data`. |
| `DATA_PUBLIC_URL` | `https://data.geomark.dev/v1` | Public data bundle URL rendered in copy-paste examples. |

## Routes

| Path | Description |
|---|---|
| `/`            | Landing page with live API showcase |
| `/v1/*`        | Same-origin API fallback proxy. In production Traefik should route this directly to API. |
| `/ready`       | Same-origin API readiness fallback proxy. |
| `/api/*`       | Legacy same-origin proxy to the upstream API, with `/api` stripped before forwarding. |
| `/health`      | Liveness probe |
| `/styles.css`  | Compiled CSS (incl. Tabler icon webfont, Fraunces, Geist Mono) |
| `/favicon.svg` | Crosshair favicon |

## Pages

- **Hero** — display headline, two-path messaging, CTAs
- **Live showcase** — Solid island that hits `/v1/search` on input. Uses `mutation.create` and `timed.debounce` from `@valentinkolb/stdlib/solid`, plus `timing.withMinLoadTime` from `@valentinkolb/stdlib` for the loader-bar floor
- **Endpoints** — list of all 10 `/v1/*` routes
- **Data** — sources, licenses, live state pulled from `/ready` at SSR time, world map sampling via `/v1/random` every 5s
- **Run it** — hosted vs self-host side by side
- **Tech** — stack facts

## Visual system

- **Display:** Fraunces (variable, opsz 9–144, SOFT 0–100, WONK)
- **Body + UI + code:** Geist Mono (everything except the headline runs in mono)
- **Accent colors:** marker orange `#FF8A3D`, chart teal `#6FE3D5`, off-white bone `#EBE7DD` on near-black ink `#07090C`
- **Atmosphere:** crosshair cursor, drifting topo lines, slow-rotating compass rose, dot graticule background

Component primitives (`.btn`, `.chip`, `.panel`, `.input-field`, `.beacon-dot`,
`.coord`, `.code-block`, `.kbd`, `.result-row`) live in `src/styles.css` under
`@layer components`.
