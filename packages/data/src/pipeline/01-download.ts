import { join, basename } from "node:path";
import { mkdir, rename, unlink } from "node:fs/promises";
import type { Stage } from "./runner";

export type DownloadConfig = {
  urls: string[];
};

export const targetPath = (stagingDir: string, url: string): string => {
  const name = basename(new URL(url).pathname);
  if (!name) {
    throw new Error(
      `URL has no filename in its path — refusing to derive download target from ${url}. ` +
        `Use a URL that ends in a filename like /file.zip.`,
    );
  }
  return join(stagingDir, "raw", name);
};

/**
 * Stream a Response body to disk via .tmp + rename. Uses a manual chunk
 * loop because `Bun.write(path, response)` was observed hanging on real
 * upstream servers (e.g. GeoNames Apache) even with valid Content-Length.
 * Manual streaming with the FileSink works reliably.
 *
 * If the upstream advertises a Content-Length, we verify the bytes
 * received match before renaming so a truncated-but-200 response cannot
 * become a "successful" partial download.
 */
const downloadOne = async (
  url: string,
  destPath: string,
  signal?: AbortSignal,
): Promise<void> => {
  const res = await fetch(url, { signal });
  if (!res.ok) {
    throw new Error(
      `download failed: ${url} (${res.status} ${res.statusText})`,
    );
  }
  if (!res.body) throw new Error(`download has no body: ${url}`);

  const lenHeader = res.headers.get("content-length");
  const expectedBytes = lenHeader ? Number(lenHeader) : null;

  const tmp = `${destPath}.tmp`;
  const sink = Bun.file(tmp).writer();
  const reader = res.body.getReader();
  let bytesWritten = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      sink.write(value);
      bytesWritten += value.length;
    }
    await sink.end();
    if (
      expectedBytes !== null &&
      Number.isFinite(expectedBytes) &&
      bytesWritten !== expectedBytes
    ) {
      throw new Error(
        `download truncated: ${url} — expected ${expectedBytes} bytes, got ${bytesWritten}`,
      );
    }
    await rename(tmp, destPath);
  } catch (err) {
    try {
      await sink.end();
    } catch {
      // ignore — sink may already be closed
    }
    await unlink(tmp).catch(() => {});
    throw err;
  }
};

/**
 * Download every configured URL into `<staging>/raw/`. Skips URLs whose
 * target already exists, so a partial run can be resumed by re-running.
 */
export const downloadStage = (cfg: DownloadConfig): Stage => {
  // Validate up-front: distinct basenames. We do this in the factory rather
  // than in `run()` because `isDone()` could otherwise short-circuit and
  // hide the collision (resumed staging where both targets already exist).
  const seen = new Map<string, string>();
  for (const url of cfg.urls) {
    // Use a dummy stagingDir for the validation; we only care about the
    // basename portion, and `targetPath` throws on URLs without a filename.
    const name = targetPath("/_validate", url).split("/").pop()!;
    const previous = seen.get(name);
    if (previous) {
      throw new Error(
        `download: URLs ${previous} and ${url} both produce filename "${name}". ` +
          `Pick distinct paths so they don't collide in <staging>/raw/.`,
      );
    }
    seen.set(name, url);
  }

  return {
    id: "download",
    isDone: async (ctx) => {
      for (const url of cfg.urls) {
        if (!(await Bun.file(targetPath(ctx.stagingDir, url)).exists())) {
          return false;
        }
      }
      return true;
    },
    run: async (ctx) => {
      await mkdir(join(ctx.stagingDir, "raw"), { recursive: true });
      for (const url of cfg.urls) {
        const dest = targetPath(ctx.stagingDir, url);
        if (await Bun.file(dest).exists()) {
          ctx.log(`[download] skip ${url} — already present`);
          continue;
        }
        ctx.log(`[download] ${url} → ${dest}`);
        await downloadOne(url, dest, ctx.signal);
      }
    },
  };
};
