import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { streamLines } from "../../src/lib/lines";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "geomark-lines-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const collect = async (path: string): Promise<string[]> => {
  const out: string[] = [];
  for await (const line of streamLines(path)) out.push(line);
  return out;
};

describe("streamLines", () => {
  test("yields newline-separated lines without the trailing newline", async () => {
    const path = join(dir, "lf.txt");
    await Bun.write(path, "alpha\nbeta\ngamma\n");
    expect(await collect(path)).toEqual(["alpha", "beta", "gamma"]);
  });

  test("handles a missing trailing newline", async () => {
    const path = join(dir, "no-trailing.txt");
    await Bun.write(path, "one\ntwo");
    expect(await collect(path)).toEqual(["one", "two"]);
  });

  test("handles CRLF line endings", async () => {
    const path = join(dir, "crlf.txt");
    await Bun.write(path, "a\r\nb\r\nc\r\n");
    expect(await collect(path)).toEqual(["a", "b", "c"]);
  });

  test("preserves empty lines", async () => {
    const path = join(dir, "empty.txt");
    await Bun.write(path, "a\n\nb\n");
    expect(await collect(path)).toEqual(["a", "", "b"]);
  });

  test("handles a multi-megabyte file split across chunks", async () => {
    const path = join(dir, "big.txt");
    const lines = Array.from({ length: 100_000 }, (_, i) => `line-${i}`);
    await Bun.write(path, lines.join("\n") + "\n");

    const result = await collect(path);
    expect(result.length).toBe(100_000);
    expect(result[0]).toBe("line-0");
    expect(result[99_999]).toBe("line-99999");
  });
});
