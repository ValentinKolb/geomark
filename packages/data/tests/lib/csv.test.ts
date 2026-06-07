import { describe, test, expect } from "bun:test";
import { csvEscape, csvRow, parseCsvLine, parseCsvHeader } from "../../src/lib/csv";

describe("csvEscape", () => {
  test("plain string passes through", () => {
    expect(csvEscape("Berlin")).toBe("Berlin");
  });

  test("null and undefined and empty become empty string", () => {
    expect(csvEscape(null)).toBe("");
    expect(csvEscape(undefined)).toBe("");
    expect(csvEscape("")).toBe("");
  });

  test("comma triggers quoting", () => {
    expect(csvEscape("Berlin, DE")).toBe('"Berlin, DE"');
  });

  test("double-quote is doubled and field is quoted", () => {
    expect(csvEscape('She said "hi"')).toBe('"She said ""hi"""');
  });

  test("newline triggers quoting", () => {
    expect(csvEscape("line1\nline2")).toBe('"line1\nline2"');
  });
});

describe("csvRow", () => {
  test("joins columns with commas and ends with LF", () => {
    expect(csvRow(["a", "b", "c"])).toBe("a,b,c\n");
  });

  test("mixes quoted and unquoted fields", () => {
    expect(csvRow(["plain", "with, comma", null])).toBe(
      'plain,"with, comma",\n',
    );
  });
});

describe("parseCsvLine", () => {
  test("splits a plain comma-separated line", () => {
    expect(parseCsvLine("a,b,c")).toEqual(["a", "b", "c"]);
  });

  test("preserves empty fields", () => {
    expect(parseCsvLine("a,,c")).toEqual(["a", "", "c"]);
    expect(parseCsvLine(",,")).toEqual(["", "", ""]);
  });

  test("respects quoted fields with embedded comma", () => {
    expect(parseCsvLine('a,"b,c",d')).toEqual(["a", "b,c", "d"]);
  });

  test("handles escaped double quote inside quoted field", () => {
    expect(parseCsvLine('"He said ""hi""",end')).toEqual([
      'He said "hi"',
      "end",
    ]);
  });

  test("round-trips with csvRow", () => {
    const original = ["plain", "with, comma", 'with "quotes"', ""];
    const line = csvRow(original).replace(/\n$/, "");
    expect(parseCsvLine(line)).toEqual(original);
  });

  test("throws on unterminated quoted field", () => {
    expect(() => parseCsvLine('a,"unterminated')).toThrow(
      /unterminated quoted CSV field/,
    );
    expect(() => parseCsvLine('a,b,"start')).toThrow(/unterminated/);
  });
});

describe("parseCsvHeader", () => {
  test("returns case-insensitive column-to-index lookup", () => {
    const idx = parseCsvHeader("Lon,Lat,Number,Street");
    expect(idx.get("LON")).toBe(0);
    expect(idx.get("STREET")).toBe(3);
  });
});
