import { rename, unlink } from "node:fs/promises";

/**
 * Compress a file via the system `zstd` binary, atomically. The compressor
 * writes to `<output>.tmp` and renames to `<output>` only after a clean
 * exit, so a crash mid-compression cannot leave a half-written `.zst` at
 * the published path. Streams natively → multi-GB inputs don't load into
 * memory.
 */
export const compressFile = async (
  input: string,
  output: string,
  level = 19,
): Promise<void> => {
  const tmp = `${output}.tmp`;
  const proc = Bun.spawn(["zstd", `-${level}`, "-q", "-f", "-o", tmp, input], {
    stdout: "ignore",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    await unlink(tmp).catch(() => {});
    throw new Error(`zstd failed (${exitCode}): ${stderr.trim()}`);
  }
  try {
    await rename(tmp, output);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
};

/** Decompress `<name>.zst` back to a target path. */
export const decompressFile = async (input: string, output: string): Promise<void> => {
  const proc = Bun.spawn(["zstd", "-d", "-q", "-f", "-o", output, input], {
    stdout: "ignore",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`zstd -d failed (${exitCode}): ${stderr.trim()}`);
  }
};
