import { config } from "./config";
import { createServer } from "./server";
import { buildOnce, setupScheduler, stopScheduler, bindMetrics } from "./scheduler";
import { createRegistry } from "./metrics/registry";

console.log("[Geomark Data] starting…");
console.log(`[Geomark Data] output dir: ${config.outputDir}`);
console.log(
  `[Geomark Data] refresh interval: ${config.refreshIntervalDays} day(s)`,
);
console.log(
  `[Geomark Data] metrics: ${
    config.metricsEnabled
      ? `enabled at ${config.metricsPath}${config.metricsToken ? " (bearer)" : " (open)"}`
      : "disabled"
  }`,
);

// Registry is always built — build counters need valid handles from boot,
// and the cost when unscraped is a few KB. Only the /metrics route and the
// HTTP RED middleware are gated on `config.metricsEnabled`.
const metrics = createRegistry();
bindMetrics(metrics);

if (config.buildOnce) {
  // External scheduler is driving us — build once and exit.
  console.log("[Geomark Data] BUILD_ONCE=true, running single build then exiting");
  await buildOnce();
  process.exit(0);
}

// Start the scheduler in the background — `/health` must come up immediately
// so liveness/readiness probes don't fail during the initial build (which can
// take hours on a fresh deployment). `/v1/latest.json` returns 404 until the
// build completes, which is the documented signal for "no dataset yet".
void setupScheduler().catch((err) => {
  console.error("[Geomark Data] scheduler setup failed:", err);
  process.exit(1);
});

const app = createServer({
  outputDir: config.outputDir,
  metrics,
  metricsEnabled: config.metricsEnabled,
  metricsToken: config.metricsToken,
  metricsPath: config.metricsPath,
});

const shutdown = async (signal: string): Promise<void> => {
  console.log(`[Geomark Data] received ${signal}, shutting down…`);
  await stopScheduler();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

export default {
  fetch: app.fetch,
};
