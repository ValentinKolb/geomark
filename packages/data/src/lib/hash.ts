/**
 * Compute SHA-256 of a file as a lowercase hex string.
 * Streams the file so multi-GB inputs don't load into memory.
 */
export const hashFile = async (path: string): Promise<string> => {
  const hasher = new Bun.CryptoHasher("sha256");
  const reader = Bun.file(path).stream().getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    hasher.update(value);
  }
  return hasher.digest("hex");
};
