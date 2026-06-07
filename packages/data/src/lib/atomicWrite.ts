import { rename, unlink } from "node:fs/promises";

/**
 * Atomic file write: data goes to `<path>.tmp`, then `rename` makes it
 * appear at `path` in one step. A crash mid-write leaves only the .tmp
 * file behind; the final path is never half-written.
 */
export const atomicWrite = async (
  path: string,
  data: string | Uint8Array,
): Promise<void> => {
  const tmp = `${path}.tmp`;
  try {
    await Bun.write(tmp, data);
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
};

/**
 * Streaming variant for large outputs (CSV stages). Open the writer, push
 * chunks, then `commit()` to publish or `abort()` to discard. Internal use
 * only — single-call lifecycle, no double-finalization handling.
 */
export const atomicWriter = (path: string) => {
  const tmp = `${path}.tmp`;
  const sink = Bun.file(tmp).writer();

  return {
    async write(chunk: string | Uint8Array) {
      sink.write(chunk);
      await sink.flush();
    },
    async commit() {
      try {
        await sink.end();
        await rename(tmp, path);
      } catch (err) {
        await unlink(tmp).catch(() => {});
        throw err;
      }
    },
    async abort() {
      try {
        await sink.end();
      } catch {
        // ignore — sink may already be closed
      }
      await unlink(tmp).catch(() => {});
    },
  };
};
