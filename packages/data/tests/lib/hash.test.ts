import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashFile } from "../../src/lib/hash";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "geomark-hash-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("hashFile", () => {
  test("hashes a known string to the known SHA-256 hex", async () => {
    const path = join(dir, "hello.txt");
    await Bun.write(path, "hello");

    expect(await hashFile(path)).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });

  test("hashes an empty file to the SHA-256-of-empty constant", async () => {
    const path = join(dir, "empty.txt");
    await Bun.write(path, "");

    expect(await hashFile(path)).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  test("streaming hash matches single-pass hash for large content", async () => {
    const path = join(dir, "big.bin");
    const data = new Uint8Array(1024 * 1024); // 1 MiB
    for (let i = 0; i < data.length; i++) data[i] = i & 0xff;
    await Bun.write(path, data);

    // Reference: hash via in-memory hasher
    const ref = new Bun.CryptoHasher("sha256");
    ref.update(data);
    const expected = ref.digest("hex");

    expect(await hashFile(path)).toBe(expected);
  });
});
