import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compressFile, decompressFile } from "../../src/lib/zstd";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "geomark-zstd-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("zstd", () => {
  test("round-trip: compress then decompress yields original bytes", async () => {
    const original = join(dir, "data.csv");
    const compressed = join(dir, "data.csv.zst");
    const restored = join(dir, "data.restored.csv");

    // Repeating content compresses very well — good signal
    const content = "name,city,country\n" + "Berlin,Berlin,DE\n".repeat(5000);
    await Bun.write(original, content);

    await compressFile(original, compressed);
    await decompressFile(compressed, restored);

    expect(await readFile(restored, "utf8")).toBe(content);
  });

  test("compressed output is smaller than input (sanity)", async () => {
    const original = join(dir, "data.csv");
    const compressed = join(dir, "data.csv.zst");
    await Bun.write(original, "line\n".repeat(10_000));

    await compressFile(original, compressed);

    const inSize = (await stat(original)).size;
    const outSize = (await stat(compressed)).size;
    expect(outSize).toBeLessThan(inSize);
  });

  test("compressed file starts with zstd magic bytes 28 b5 2f fd", async () => {
    const original = join(dir, "data.txt");
    const compressed = join(dir, "data.txt.zst");
    await Bun.write(original, "hello zstd");

    await compressFile(original, compressed);

    const buf = await Bun.file(compressed).bytes();
    expect(buf[0]).toBe(0x28);
    expect(buf[1]).toBe(0xb5);
    expect(buf[2]).toBe(0x2f);
    expect(buf[3]).toBe(0xfd);
  });

  test("compress on missing input throws", async () => {
    const missing = join(dir, "nope.csv");
    const out = join(dir, "nope.csv.zst");
    await expect(compressFile(missing, out)).rejects.toThrow();
  });
});
