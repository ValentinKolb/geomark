import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCsvLine, parseCsvHeader } from "../src/lib/csv";
import { sha256, sha256OfFile, streamLines, toHex } from "../src/lib/streams";
import { toPgTextArray } from "../src/db";

describe("csv parser", () => {
  test("plain fields", () => {
    expect(parseCsvLine("a,b,c")).toEqual(["a", "b", "c"]);
  });

  test("empty fields", () => {
    expect(parseCsvLine("a,,c")).toEqual(["a", "", "c"]);
    expect(parseCsvLine(",")).toEqual(["", ""]);
  });

  test("quoted field with comma inside", () => {
    expect(parseCsvLine('"a,b",c')).toEqual(["a,b", "c"]);
  });

  test("quoted field with escaped quote", () => {
    expect(parseCsvLine('"he said ""hi""",x')).toEqual(['he said "hi"', "x"]);
  });

  test("throws on unterminated quoted field", () => {
    expect(() => parseCsvLine('"never closed,foo')).toThrow(
      /unterminated/i,
    );
  });

  test("parseCsvHeader uppercases keys", () => {
    const map = parseCsvHeader("Name,LAT,Long");
    expect(map.get("NAME")).toBe(0);
    expect(map.get("LAT")).toBe(1);
    expect(map.get("LONG")).toBe(2);
  });
});

describe("streams + hash helpers", () => {
  test("toHex roundtrip", () => {
    const hex = toHex(new Uint8Array([0x00, 0xff, 0xab, 0x10]));
    expect(hex).toBe("00ffab10");
  });

  test("sha256 of known input", async () => {
    const bytes = new TextEncoder().encode("hello");
    expect(await sha256(bytes)).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });

  test("sha256OfFile streams from disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "geo-test-"));
    try {
      const path = join(dir, "x");
      await writeFile(path, "hello");
      expect(await sha256OfFile(path)).toBe(
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("streamLines yields newline-split lines", async () => {
    const data = new TextEncoder().encode("a\nb\nc\n");
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(data);
        c.close();
      },
    });
    const lines: string[] = [];
    for await (const l of streamLines(stream)) lines.push(l);
    expect(lines).toEqual(["a", "b", "c"]);
  });

  test("streamLines handles chunk boundaries inside a line", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("hello "));
        c.enqueue(new TextEncoder().encode("world\nfoo"));
        c.close();
      },
    });
    const lines: string[] = [];
    for await (const l of streamLines(stream)) lines.push(l);
    expect(lines).toEqual(["hello world", "foo"]);
  });

  test("streamLines decodes multi-byte chars across chunks", async () => {
    const utf8 = new TextEncoder().encode("Müllerstraße\n");
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        // Split mid-Mü so the ü's 2-byte sequence straddles a boundary.
        c.enqueue(utf8.slice(0, 2));
        c.enqueue(utf8.slice(2));
        c.close();
      },
    });
    const lines: string[] = [];
    for await (const l of streamLines(stream)) lines.push(l);
    expect(lines).toEqual(["Müllerstraße"]);
  });
});

describe("db helpers", () => {
  test("toPgTextArray", () => {
    expect(toPgTextArray([])).toBe("{}");
    expect(toPgTextArray(["de"])).toBe('{"de"}');
    expect(toPgTextArray(["de", "en"])).toBe('{"de","en"}');
  });

  test("toPgTextArray escapes quotes + backslashes", () => {
    expect(toPgTextArray(['ka"boom'])).toBe('{"ka\\"boom"}');
    expect(toPgTextArray(["c:\\path"])).toBe('{"c:\\\\path"}');
  });
});
