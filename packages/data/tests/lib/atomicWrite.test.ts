import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWrite, atomicWriter } from "../../src/lib/atomicWrite";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "geomark-atomic-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const exists = (p: string): Promise<boolean> =>
  access(p).then(() => true).catch(() => false);

describe("atomicWrite", () => {
  test("writes file at the target path", async () => {
    const target = join(dir, "out.txt");
    await atomicWrite(target, "hello");

    expect(await readFile(target, "utf8")).toBe("hello");
  });

  test("does not leave .tmp behind on success", async () => {
    const target = join(dir, "out.txt");
    await atomicWrite(target, "hello");

    expect(await exists(`${target}.tmp`)).toBe(false);
  });

  test("cleans up .tmp on rename failure", async () => {
    // Target path is occupied by a directory — rename file → dir fails
    const target = join(dir, "occupied");
    await Bun.write(join(target, "child.txt"), "child");

    await expect(atomicWrite(target, "hello")).rejects.toThrow();
    expect(await exists(`${target}.tmp`)).toBe(false);
  });

  test("overwrites stale .tmp from previous run", async () => {
    const target = join(dir, "out.txt");
    await Bun.write(`${target}.tmp`, "stale");

    await atomicWrite(target, "fresh");
    expect(await readFile(target, "utf8")).toBe("fresh");
    expect(await exists(`${target}.tmp`)).toBe(false);
  });
});

describe("atomicWriter", () => {
  test("commits chunked writes to target path", async () => {
    const target = join(dir, "stream.csv");
    const w = atomicWriter(target);

    await w.write("a,b,c\n");
    await w.write("1,2,3\n");
    await w.commit();

    expect(await readFile(target, "utf8")).toBe("a,b,c\n1,2,3\n");
  });

  test("does not produce target file on abort", async () => {
    const target = join(dir, "stream.csv");
    const w = atomicWriter(target);

    await w.write("a,b\n");
    await w.abort();

    expect(await exists(target)).toBe(false);
    expect(await exists(`${target}.tmp`)).toBe(false);
  });

});
