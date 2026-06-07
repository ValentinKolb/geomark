import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractStage, isUnsafePath } from "../../src/pipeline/02-extract";
import type { StageCtx } from "../../src/pipeline/runner";

let dir: string;
let stagingDir: string;
let outputDir: string;

const makeZip = async (zipPath: string, files: Record<string, string>): Promise<void> => {
  const tmpDir = `${zipPath}.src`;
  await mkdir(tmpDir, { recursive: true });
  const filenames: string[] = [];
  for (const [name, content] of Object.entries(files)) {
    const filePath = join(tmpDir, name);
    await Bun.write(filePath, content);
    filenames.push(filePath);
  }
  // -j strips paths so the zip contains flat filenames
  const proc = Bun.spawn(["zip", "-q", "-j", zipPath, ...filenames]);
  const exit = await proc.exited;
  if (exit !== 0) throw new Error(`zip failed (${exit}) creating ${zipPath}`);
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "geomark-extract-"));
  stagingDir = join(dir, "staging");
  outputDir = join(dir, "out");
  await mkdir(join(stagingDir, "raw"), { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const makeCtx = (): StageCtx => ({
  stagingDir,
  outputDir,
  log: () => {},
});

describe("extractStage", () => {
  test("extracts a single zip into staging/extracted/", async () => {
    await makeZip(join(stagingDir, "raw", "data.zip"), {
      "countryInfo.txt": "ISO\theader\nDE\tdata\n",
    });

    await extractStage.run(makeCtx());

    const content = await readFile(
      join(stagingDir, "extracted", "countryInfo.txt"),
      "utf8",
    );
    expect(content).toBe("ISO\theader\nDE\tdata\n");
  });

  test("extracts multiple zips and concatenates outputs into the same dir", async () => {
    await makeZip(join(stagingDir, "raw", "a.zip"), { "a.txt": "AAA" });
    await makeZip(join(stagingDir, "raw", "b.zip"), { "b.txt": "BBB" });

    await extractStage.run(makeCtx());

    expect(await readFile(join(stagingDir, "extracted", "a.txt"), "utf8")).toBe("AAA");
    expect(await readFile(join(stagingDir, "extracted", "b.txt"), "utf8")).toBe("BBB");
  });

  test("writes a .done sentinel after a successful run", async () => {
    await makeZip(join(stagingDir, "raw", "data.zip"), { "x.txt": "x" });
    await extractStage.run(makeCtx());

    expect(await Bun.file(join(stagingDir, "extracted", ".done")).exists()).toBe(true);
  });

  test("isDone is false without sentinel and true once present", async () => {
    expect(await extractStage.isDone(makeCtx())).toBe(false);

    await mkdir(join(stagingDir, "extracted"), { recursive: true });
    await Bun.write(join(stagingDir, "extracted", ".done"), "");

    expect(await extractStage.isDone(makeCtx())).toBe(true);
  });

  test("throws on a corrupt zip", async () => {
    await Bun.write(join(stagingDir, "raw", "broken.zip"), "not a zip");
    await expect(extractStage.run(makeCtx())).rejects.toThrow(/unzip/);
  });

  test("copies .txt files (e.g. countryInfo.txt) straight through", async () => {
    await Bun.write(
      join(stagingDir, "raw", "countryInfo.txt"),
      "# header\nDE\tDEU\tdata\n",
    );
    await extractStage.run(makeCtx());

    const out = await readFile(
      join(stagingDir, "extracted", "countryInfo.txt"),
      "utf8",
    );
    expect(out).toBe("# header\nDE\tDEU\tdata\n");
  });

});

describe("isUnsafePath (zip-slip guard)", () => {
  test("flags absolute paths", () => {
    expect(isUnsafePath("/etc/passwd")).toBe(true);
    expect(isUnsafePath("\\windows\\evil")).toBe(true);
  });

  test("flags any segment of ..", () => {
    expect(isUnsafePath("../escape.txt")).toBe(true);
    expect(isUnsafePath("dir/../escape.txt")).toBe(true);
    expect(isUnsafePath("dir/sub/../../escape.txt")).toBe(true);
  });

  test("flags windows-style drive letters", () => {
    expect(isUnsafePath("C:/evil")).toBe(true);
    expect(isUnsafePath("d:\\evil")).toBe(true);
  });

  test("accepts normal nested paths", () => {
    expect(isUnsafePath("cities500.txt")).toBe(false);
    expect(isUnsafePath("openaddresses/de.csv")).toBe(false);
    expect(isUnsafePath("nested/sub/file.tsv")).toBe(false);
  });

  test("does NOT mistake filenames with two dots in them", () => {
    expect(isUnsafePath("..foo")).toBe(false); // ".." as substring, not segment
    expect(isUnsafePath("file..bak")).toBe(false);
  });
});
