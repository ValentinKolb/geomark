#!/usr/bin/env bun
/**
 * Sequential test runner. Bun spawns docker containers from each test
 * file; running 4+ in parallel exhausts docker daemon throughput and
 * makes pg startup unstable (Connection closed mid-startup). Running
 * files one-at-a-time keeps the wall-clock cost reasonable (~30-40s
 * total) and is fully deterministic.
 *
 * Each test file still spawns its own ephemeral container with a
 * unique name + docker-assigned port — other running containers are
 * never touched.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const TEST_DIR = new URL("./", import.meta.url).pathname;

const findTests = async (): Promise<string[]> => {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) await walk(p);
      else if (entry.isFile() && entry.name.endsWith(".test.ts")) out.push(p);
    }
  };
  await walk(TEST_DIR);
  return out.sort();
};

const main = async (): Promise<void> => {
  // `--all` opts in to running every file even after a failure (handy
  // when triaging multiple unrelated regressions). Default is fail-fast
  // so a broken DB harness doesn't burn another minute spawning more
  // doomed containers.
  const args = process.argv.slice(2);
  const allIdx = args.indexOf("--all");
  const failFast = allIdx === -1;
  const passthrough = allIdx === -1 ? args : args.filter((_, i) => i !== allIdx);

  const files = await findTests();
  console.log(
    `Running ${files.length} test file(s) sequentially${failFast ? " (fail-fast)" : ""}:\n`,
  );
  let totalPass = 0;
  let totalFail = 0;
  let firstFailFile: string | null = null;

  for (const f of files) {
    const rel = f.replace(`${process.cwd()}/`, "");
    console.log(`\n──── ${rel} ────`);
    const start = Date.now();
    const r = Bun.spawnSync(
      ["bun", "test", f, ...passthrough],
      {
        stdio: ["inherit", "inherit", "inherit"],
        env: process.env,
      },
    );
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    if (r.exitCode === 0) {
      console.log(`✓ ${rel} (${elapsed}s)`);
      totalPass++;
    } else {
      console.log(`✗ ${rel} (${elapsed}s, exit ${r.exitCode})`);
      totalFail++;
      if (!firstFailFile) firstFailFile = rel;
      if (failFast) break;
    }
  }

  console.log(`\n=== ${totalPass} files passed, ${totalFail} failed ===`);
  if (firstFailFile) {
    console.log(`first failure: ${firstFailFile}`);
    process.exit(1);
  }
  process.exit(0);
};

await main();
