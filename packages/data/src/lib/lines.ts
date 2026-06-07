/**
 * Stream the lines of a file without loading the whole content into memory.
 * Yields one line per iteration, without the trailing newline. Handles both
 * `\n` and `\r\n` line endings.
 */
export async function* streamLines(path: string): AsyncGenerator<string> {
  const reader = Bun.file(path).stream().getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      yield line.endsWith("\r") ? line.slice(0, -1) : line;
    }
  }

  // Flush any final residue not terminated by a newline
  buffer += decoder.decode();
  if (buffer.length > 0) {
    yield buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
  }
}
