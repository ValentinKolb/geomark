/**
 * Test-DB helper. Spawns a uniquely-named timescaledb-ha container with
 * a docker-assigned random host port, waits for readiness, returns the
 * connection URL plus a stop function.
 *
 * Each test file calls `spawnTestDb()` in `beforeAll` and `stop()` in
 * `afterAll` so test files run in parallel without sharing state. Other
 * running docker containers are NEVER touched (unique names + `docker
 * stop <id>` only on our own).
 */
const IMAGE = "timescale/timescaledb-ha:pg17-all";
const READY_TIMEOUT_MS = 120_000;
const STABILITY_PROBES = 3;
const STABILITY_INTERVAL_MS = 1_000;

// Track all containers we've spawned so an unexpected process exit
// (uncaught exception, SIGINT, test runner kill) doesn't leak them.
const liveContainers = new Set<string>();
let exitHooksInstalled = false;
const installExitHooks = (): void => {
  if (exitHooksInstalled) return;
  exitHooksInstalled = true;
  const cleanup = (): void => {
    for (const id of liveContainers) {
      Bun.spawnSync(["docker", "stop", "-t", "1", id], {
        stderr: "ignore",
        stdout: "ignore",
      });
    }
    liveContainers.clear();
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });
  process.on("uncaughtException", (e) => {
    cleanup();
    throw e;
  });
};

export type TestDb = {
  /** postgres://test:test@localhost:<random>/test */
  url: string;
  /** Stops + removes the container. Idempotent. */
  stop: () => Promise<void>;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

const randId = (): string => {
  const u = crypto.randomUUID().replaceAll("-", "");
  return u.slice(0, 12);
};

const inspectHostPort = (containerId: string): number => {
  const proc = Bun.spawnSync([
    "docker", "port", containerId, "5432/tcp",
  ]);
  if (proc.exitCode !== 0) {
    throw new Error(
      `docker port ${containerId} failed: ${proc.stderr.toString()}`,
    );
  }
  // Output e.g.:
  //   0.0.0.0:54393
  //   :::54393
  const lines = proc.stdout.toString().split("\n").filter(Boolean);
  for (const line of lines) {
    const m = line.match(/:(\d+)$/);
    if (m && m[1]) return Number(m[1]);
  }
  throw new Error(`could not parse host port from: ${proc.stdout.toString()}`);
};

export const spawnTestDb = async (): Promise<TestDb> => {
  const name = `geomark-test-${randId()}`;
  // Use --publish-all (-P) so docker picks a free host port and we
  // never collide with other services.
  const run = Bun.spawnSync([
    "docker", "run", "-d", "--rm",
    "--name", name,
    "-P",
    "-e", "POSTGRES_PASSWORD=test",
    "-e", "POSTGRES_USER=test",
    "-e", "POSTGRES_DB=test",
    IMAGE,
  ]);
  if (run.exitCode !== 0) {
    throw new Error(`docker run failed: ${run.stderr.toString()}`);
  }
  const containerId = run.stdout.toString().trim();
  if (!containerId) throw new Error("docker run produced no id");
  liveContainers.add(containerId);
  installExitHooks();

  const stop = async (): Promise<void> => {
    // -t 1 → 1-second graceful stop. These are disposable test
    // containers; default 10s is wasteful and slows the test runner.
    Bun.spawnSync(["docker", "stop", "-t", "1", containerId], {
      stderr: "ignore",
      stdout: "ignore",
    });
    liveContainers.delete(containerId);
  };

  try {
    const port = inspectHostPort(containerId);
    const url = `postgres://test:test@localhost:${port}/test`;

    // timescaledb-ha goes through several startup stages: initdb →
    // listen → reload-for-extensions → ready. `pg_isready` returns
    // true at LISTEN, but a connection that lands during reload gets
    // dropped. Probe via `psql SELECT 1` from INSIDE the container
    // until it succeeds N times in a row, then verify from the host.
    const start = Date.now();
    let stableInside = 0;
    while (Date.now() - start < READY_TIMEOUT_MS) {
      const inside = Bun.spawnSync(
        [
          "docker", "exec", containerId,
          "psql", "-U", "test", "-d", "test", "-tAc", "SELECT 1",
        ],
        { stderr: "ignore", stdout: "ignore" },
      );
      if (inside.exitCode === 0) {
        stableInside++;
        if (stableInside >= STABILITY_PROBES) {
          // From the host, retry connecting until success. Use Bun's
          // sql directly — that's what callers will use.
          const probeUrl = url;
          const { SQL } = await import("bun");
          let lastErr: unknown;
          for (let i = 0; i < 30; i++) {
            const probeSql = new SQL(probeUrl);
            try {
              await probeSql`SELECT 1`;
              await probeSql.end().catch(() => {});
              return { url, stop };
            } catch (e) {
              lastErr = e;
              await probeSql.end().catch(() => {});
              await sleep(STABILITY_INTERVAL_MS);
            }
          }
          throw new Error(
            `host probe never succeeded after inside-container stability: ${String(lastErr)}`,
          );
        }
        await sleep(STABILITY_INTERVAL_MS);
      } else {
        stableInside = 0;
        await sleep(500);
      }
    }
    throw new Error(`postgres in ${name} never became ready`);
  } catch (e) {
    await stop().catch(() => {});
    throw e;
  }
};

/**
 * Convenience: set DATABASE_URL for `import { sql } from "bun"` to pick
 * up. Bun's sql reads the env lazily on first connect.
 */
export const setDatabaseUrl = (url: string): void => {
  process.env.DATABASE_URL = url;
};
