/**
 * Async-iterate `\n`-separated lines from a Uint8Array ReadableStream.
 * Decodes UTF-8 with stream-aware decoder so multi-byte chars at chunk
 * boundaries don't corrupt. Skips empty trailing line.
 */
export async function* streamLines(
  readable: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const decoder = new TextDecoder("utf-8");
  const reader = readable.getReader();
  let buf = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        const tail = buf + decoder.decode();
        if (tail.length > 0) yield tail;
        return;
      }
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        yield buf.slice(0, nl);
        buf = buf.slice(nl + 1);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Hex-encode bytes (lowercase, no separator). */
export const toHex = (bytes: Uint8Array): string => {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i]!.toString(16).padStart(2, "0");
  }
  return s;
};

/** SHA-256 of a buffer, hex-encoded. */
export const sha256 = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return toHex(new Uint8Array(digest));
};

/** Streaming SHA-256 of a file on disk. No full-file read into memory. */
export const sha256OfFile = async (path: string): Promise<string> => {
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256");
  const stream = Bun.file(path).stream();
  // @ts-expect-error — Bun's ReadableStream is async-iterable
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
};
