/**
 * Executable entrypoint. Runs migrations, starts the loader, builds the
 * app via the `createApp()` factory, and registers signal handlers.
 *
 * Tests / embedding callers should import `createApp()` from `./app`
 * directly — it has no side effects beyond constructing the app.
 */
import { config } from "./config";
import { migrate } from "./migrate";
import { setupLoader, stopLoader, loadOnce, bindMetrics } from "./loader";
import { createApp } from "./app";
import { closeRedis } from "./lib/redis";

console.log("[Geomark] Starting…");
console.log(`[Geomark] DB: ${config.databaseUrl.replace(/:[^:@]+@/, ":***@")}`);
console.log(`[Geomark] Data source: ${config.dataUrl}`);
console.log(`[Geomark] Auth: ${config.requiresAuth ? "API key required" : "open"}`);
console.log(`[Geomark] Redis: ${config.redisUrl ? "enabled" : "disabled"}`);
console.log(`[Geomark] Rate-limit: ${config.ratelimitPerMinute}/min/IP`);
console.log(`[Geomark] Trusted proxy hops: ${config.trustedProxyHops}`);
console.log(
  `[Geomark] Metrics: ${
    config.metricsEnabled
      ? `${config.metricsPath} (${
          config.metricsToken
            ? "METRICS_TOKEN"
            : config.requiresAuth
              ? "API_KEY fallback"
              : "open"
        })`
      : "disabled"
  }`,
);

console.log("[Geomark] Running migrations…");
await migrate();
console.log("[Geomark] Migrations done.");

// Build the app first so the metrics registry exists before the loader
// touches its dataset gauges. createApp() is pure aside from a Scalar
// docs render — no DB calls, safe to run before the loader.
const { app, metrics } = await createApp();
bindMetrics(metrics);

if (config.loadOnce) {
  console.log("[Geomark] LOAD_ONCE enabled — running single refresh and exiting.");
  await loadOnce();
  process.exit(0);
}

// Loader runs in the background so /health (and /docs) come up immediately.
// The initial refresh can take a while on real-world data sizes.
void setupLoader().catch((err) => {
  console.error("[Geomark] loader setup failed:", err);
});

const shutdown = (signal: string): void => {
  console.log(`[Geomark] received ${signal}, shutting down…`);
  stopLoader();
  closeRedis();
  process.exit(0);
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

export default {
  fetch: app.fetch,
};
