import { join } from "node:path";
import { mkdir, readdir, stat, unlink } from "node:fs/promises";
import { compressFile } from "../lib/zstd";
import { hashFile } from "../lib/hash";
import { atomicWrite } from "../lib/atomicWrite";
import type { Stage } from "./runner";

export type ManifestSources = {
  geonames_cities_url: string;
  geonames_postal_url: string;
  geonames_country_info_url: string;
  openaddresses_url: string;
  /** Only present if the aliases stage ran. */
  geonames_aliases_url?: string;
};

export type FileEntry = {
  filename: string;
  sha256: string;
  size_bytes: number;
  /** Total newline-terminated lines in the *.csv.zst file (including header). */
  line_count: number;
};

export type AddressFileEntry = FileEntry & { country_code: string };

export type Manifest = {
  built_at: string;
  version: string;
  license: {
    geonames: string;
    openaddresses: string;
  };
  files: {
    places: FileEntry;
    postal_codes: FileEntry;
    countries: FileEntry;
    addresses: AddressFileEntry[];
    /** Only present if the aliases stage produced output. */
    aliases?: FileEntry;
  };
  coverage: Record<string, "address">;
  sources: ManifestSources;
};

const LICENSES = {
  geonames: "CC-BY-4.0",
  openaddresses:
    "mixed per-source (CC0 / CC BY / ODbL / public domain); see https://github.com/openaddresses/openaddresses/blob/master/sources.csv",
} as const;

const ADDRESS_FILE = /^addresses-([a-z]{2})\.csv\.zst$/;
const SINGLE_FILES = ["places", "postal_codes", "countries"] as const;

const csvsIn = async (dir: string): Promise<string[]> => {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith(".csv")).sort();
  } catch {
    return [];
  }
};

/** Stream-decompress a zstd file and count newlines. */
const countLines = async (path: string): Promise<number> => {
  const proc = Bun.spawn(["zstd", "-dcq", path], {
    stdout: "pipe",
    stderr: "pipe",
  });
  let count = 0;
  const reader = proc.stdout.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    for (let i = 0; i < value.length; i++) {
      if (value[i] === 0x0a) count++;
    }
  }
  if ((await proc.exited) !== 0) {
    throw new Error(`zstd -dcq failed for ${path}`);
  }
  return count;
};

const fileEntry = async (path: string, filename: string): Promise<FileEntry> => {
  // Sequential, NOT Promise.all: parallel hash + decompress on the same
  // file triggers a Bun stream/spawn race that under-counts newlines.
  const s = await stat(path);
  const sha256 = await hashFile(path);
  const line_count = await countLines(path);
  return { filename, sha256, size_bytes: s.size, line_count };
};

/**
 * Publish stage: compresses every `<staging>/*.csv` to `<output>/*.csv.zst`,
 * prunes stale outputs, and writes the canonical `latest.json` manifest.
 *
 * Always re-runs (no skip-by-existence). Atomic per file (zstd writes to
 * `.tmp` and renames). Manifest written last as the visible "commit" of a
 * fresh dataset.
 */
export const publishStage = (sources: ManifestSources): Stage => ({
  id: "publish",
  isDone: async () => false,
  run: async (ctx) => {
    await mkdir(ctx.outputDir, { recursive: true });
    const csvs = await csvsIn(ctx.stagingDir);
    if (csvs.length === 0) {
      throw new Error(
        `publish stage: no CSV files in ${ctx.stagingDir}. ` +
          `Upstream stages must produce at least one *.csv before publishing.`,
      );
    }

    // 1. Compress every staging CSV (atomic per file, overwrites prior output).
    for (const csv of csvs) {
      const inPath = join(ctx.stagingDir, csv);
      const outPath = join(ctx.outputDir, `${csv}.zst`);
      await compressFile(inPath, outPath);
    }

    // 2. Prune stale outputs whose source CSV no longer exists in staging.
    const expected = new Set(csvs.map((f) => `${f}.zst`));
    let pruned = 0;
    for (const f of await readdir(ctx.outputDir)) {
      if (!f.endsWith(".csv.zst")) continue;
      if (!expected.has(f)) {
        await unlink(join(ctx.outputDir, f)).catch(() => {});
        pruned++;
      }
    }

    // 3. Hash + line-count every published file.
    const singles: Record<string, FileEntry> = {};
    for (const name of SINGLE_FILES) {
      const filename = `${name}.csv.zst`;
      singles[name] = await fileEntry(join(ctx.outputDir, filename), filename);
    }

    const addressFiles: AddressFileEntry[] = [];
    const coverage: Record<string, "address"> = {};
    for (const f of await readdir(ctx.outputDir)) {
      const m = ADDRESS_FILE.exec(f);
      if (!m) continue;
      const country_code = m[1]!.toUpperCase();
      const entry = await fileEntry(join(ctx.outputDir, f), f);
      addressFiles.push({ ...entry, country_code });
      coverage[country_code] = "address";
    }
    addressFiles.sort((a, b) => a.country_code.localeCompare(b.country_code));

    // Optional aliases artefact — only listed in the manifest if the
    // aliases stage actually produced output.
    let aliasesEntry: FileEntry | undefined;
    const aliasesPath = join(ctx.outputDir, "aliases.csv.zst");
    if (await Bun.file(aliasesPath).exists()) {
      aliasesEntry = await fileEntry(aliasesPath, "aliases.csv.zst");
    }

    // 4. Write the manifest atomically — the visible "commit" of the build.
    const manifest: Manifest = {
      built_at: new Date().toISOString(),
      version: new Date().toISOString().slice(0, 10),
      license: { ...LICENSES },
      files: {
        places: singles.places!,
        postal_codes: singles.postal_codes!,
        countries: singles.countries!,
        addresses: addressFiles,
        ...(aliasesEntry ? { aliases: aliasesEntry } : {}),
      },
      coverage,
      sources,
    };
    await atomicWrite(
      join(ctx.outputDir, "latest.json"),
      JSON.stringify(manifest, null, 2),
    );

    ctx.log(
      `[publish] ${csvs.length} compressed, ${pruned} pruned, ${addressFiles.length} address chunk(s)${aliasesEntry ? `, +aliases (${aliasesEntry.line_count} rows)` : ""}`,
    );
  },
});
