import { join } from "node:path";
import { mkdir, readdir, copyFile } from "node:fs/promises";
import type { Stage } from "./runner";

const SENTINEL = ".done";
const ZIP_MAGIC = "504b0304";

export const isUnsafePath = (entry: string): boolean => {
  // Reject zip entries that would escape the destination directory:
  //   - absolute paths
  //   - any segment of ".."
  //   - drive letters (windows-style, defensive)
  if (entry.startsWith("/") || entry.startsWith("\\")) return true;
  if (/^[a-zA-Z]:/.test(entry)) return true;
  return entry.split(/[\\/]/).some((segment) => segment === "..");
};

const listZipEntries = async (zipPath: string): Promise<string[]> => {
  // -Z1 = unzip-info, one filename per line, no headers.
  const proc = Bun.spawn(["unzip", "-Z1", zipPath], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(
      `unzip -Z1 failed (${exitCode}) for ${zipPath}: ${stderr.trim()}`,
    );
  }
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
};

const unzipOne = async (zipPath: string, outDir: string): Promise<void> => {
  // Zip-slip guard — refuse to extract archives that contain paths trying
  // to escape `outDir`. We validate the entry list before letting `unzip`
  // touch anything on disk.
  const entries = await listZipEntries(zipPath);
  const unsafe = entries.filter(isUnsafePath);
  if (unsafe.length > 0) {
    throw new Error(
      `unsafe zip entries in ${zipPath}: ${unsafe.slice(0, 5).join(", ")}` +
        (unsafe.length > 5 ? ` (+${unsafe.length - 5} more)` : ""),
    );
  }

  const proc = Bun.spawn(["unzip", "-o", "-q", zipPath, "-d", outDir], {
    stdout: "ignore",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`unzip failed (${exitCode}) for ${zipPath}: ${stderr.trim()}`);
  }
};

export const isZipFile = async (path: string): Promise<boolean> => {
  if (path.toLowerCase().endsWith(".zip")) return true;
  const bytes = new Uint8Array(await Bun.file(path).slice(0, 4).arrayBuffer());
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex === ZIP_MAGIC;
};

/**
 * Extract every .zip in `<staging>/raw/` into `<staging>/extracted/`, and
 * copy plain .txt files straight through (some GeoNames sources like
 * countryInfo.txt are not zipped). A `.done` sentinel is written at the end
 * so a partial mid-way crash doesn't make the stage look complete on rerun.
 */
export const extractStage: Stage = {
  id: "extract",
  isDone: async (ctx) =>
    Bun.file(join(ctx.stagingDir, "extracted", SENTINEL)).exists(),
  run: async (ctx) => {
    const rawDir = join(ctx.stagingDir, "raw");
    const outDir = join(ctx.stagingDir, "extracted");
    await mkdir(outDir, { recursive: true });

    const entries = await readdir(rawDir, { withFileTypes: true });
    let zips = 0;
    let copies = 0;

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const f = entry.name;
      const path = join(rawDir, f);
      const lower = f.toLowerCase();
      if (await isZipFile(path)) {
        ctx.log(`[extract] unzip ${f}`);
        await unzipOne(path, outDir);
        zips++;
      } else if (lower.endsWith(".txt")) {
        ctx.log(`[extract] copy ${f}`);
        await copyFile(path, join(outDir, f));
        copies++;
      }
    }

    await Bun.write(join(outDir, SENTINEL), "");
    ctx.log(`[extract] ${zips} zip(s) extracted, ${copies} txt copied`);
  },
};
