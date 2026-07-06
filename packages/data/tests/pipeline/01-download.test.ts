import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
  afterAll,
} from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadStage, targetPath } from "../../src/pipeline/01-download";
import type { StageCtx } from "../../src/pipeline/runner";

let dir: string;
let stagingDir: string;
let outputDir: string;
const originalFetch = globalThis.fetch;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "geomark-download-"));
  stagingDir = join(dir, "staging");
  outputDir = join(dir, "out");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

const makeCtx = (): StageCtx => ({
  stagingDir,
  outputDir,
  log: () => {},
});

const stubFetch = (responses: Record<string, (init?: RequestInit) => Response>): void => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const builder = responses[url];
    if (!builder) throw new Error(`unstubbed fetch: ${url}`);
    return builder(init);
  }) as typeof fetch;
};

describe("downloadStage", () => {
  test("downloads each URL into <staging>/raw/<basename>", async () => {
    const url1 = "https://example.com/cities500.zip";
    const url2 = "https://example.com/sub/allCountries.zip";
    stubFetch({
      [url1]: () => new Response("zip-1-contents", { status: 200 }),
      [url2]: () => new Response("zip-2-contents", { status: 200 }),
    });

    const stage = downloadStage({ urls: [url1, url2] });
    await stage.run(makeCtx());

    expect(await readFile(targetPath(stagingDir, url1), "utf8")).toBe(
      "zip-1-contents",
    );
    expect(await readFile(targetPath(stagingDir, url2), "utf8")).toBe(
      "zip-2-contents",
    );
  });

  test("throws on non-2xx response", async () => {
    const url = "https://example.com/missing.zip";
    stubFetch({
      [url]: () => new Response("not found", { status: 404 }),
    });

    const stage = downloadStage({ urls: [url] });
    await expect(stage.run(makeCtx())).rejects.toThrow(/download failed/);
  });

  test("isDone is true only when all URLs have files locally", async () => {
    const url1 = "https://example.com/a.zip";
    const url2 = "https://example.com/b.zip";
    stubFetch({
      [url1]: () => new Response("a", { status: 200 }),
      [url2]: () => new Response("b", { status: 200 }),
    });

    const stage = downloadStage({ urls: [url1, url2] });
    expect(await stage.isDone(makeCtx())).toBe(false);

    await stage.run(makeCtx());
    expect(await stage.isDone(makeCtx())).toBe(true);
  });

  test("rejects URL pairs that would collide on the same filename (at factory time)", () => {
    const url1 = "https://hostA.com/data.zip";
    const url2 = "https://hostB.com/data.zip";
    expect(() => downloadStage({ urls: [url1, url2] })).toThrow(
      /both produce filename "data.zip"/,
    );
  });

  test("rejects truncated downloads when Content-Length doesn't match", async () => {
    const url = "https://example.com/data.zip";
    stubFetch({
      [url]: () =>
        // Body is 5 bytes but we lie about the length
        new Response("short", {
          status: 200,
          headers: { "Content-Length": "100" },
        }),
    });

    await expect(
      downloadStage({ urls: [url] }).run(makeCtx()),
    ).rejects.toThrow(/truncated/);

    // Final file must NOT exist after truncated download
    expect(
      await Bun.file(targetPath(stagingDir, url)).exists(),
    ).toBe(false);
  });

  test("rejects URLs with no filename in their path (Bug #5)", () => {
    expect(() => targetPath("/staging", "https://example.com/")).toThrow(
      /no filename in its path/,
    );
    expect(() => targetPath("/staging", "https://example.com")).toThrow(
      /no filename in its path/,
    );
  });

  test("accepts URLs with a regular filename", () => {
    expect(targetPath("/staging", "https://example.com/data.zip")).toMatch(
      /\/staging\/raw\/data\.zip$/,
    );
  });

  test("accepts endpoint-style OpenAddresses Batch URLs", () => {
    expect(
      targetPath("/staging", "https://batch.openaddresses.io/api/collections/1/data"),
    ).toMatch(/\/staging\/raw\/data$/);
  });

  test("sends configured bearer token only for matching URL", async () => {
    const oaUrl = "https://batch.openaddresses.io/api/collections/2/data";
    const publicUrl = "https://download.geonames.org/export/dump/cities500.zip";
    const seen: Record<string, string | null> = {};
    stubFetch({
      [oaUrl]: (init) => {
        seen.oa = new Headers(init?.headers).get("authorization");
        return new Response("oa", { status: 200 });
      },
      [publicUrl]: (init) => {
        seen.public = new Headers(init?.headers).get("authorization");
        return new Response("public", { status: 200 });
      },
    });

    await downloadStage({
      urls: [oaUrl, publicUrl],
      bearerTokens: { [oaUrl]: "secret-token" },
    }).run(makeCtx());

    expect(seen.oa).toBe("Bearer secret-token");
    expect(seen.public).toBeNull();
  });

  test("does not include bearer token in download errors", async () => {
    const url = "https://batch.openaddresses.io/api/collections/1/data";
    stubFetch({
      [url]: () => new Response("forbidden", { status: 403, statusText: "Forbidden" }),
    });

    let message = "";
    try {
      await downloadStage({
        urls: [url],
        bearerTokens: { [url]: "do-not-log-this" },
      }).run(makeCtx());
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    expect(message).toContain("403");
    expect(message).toContain(url);
    expect(message).not.toContain("do-not-log-this");
  });

  test("skips URLs whose target file already exists", async () => {
    const url1 = "https://example.com/a.zip";
    const url2 = "https://example.com/b.zip";

    // Pre-populate the first target so it must NOT be re-fetched
    await Bun.write(targetPath(stagingDir, url1), "previous");

    let url2Hit = false;
    stubFetch({
      [url1]: () => {
        throw new Error("should not be fetched");
      },
      [url2]: () => {
        url2Hit = true;
        return new Response("fresh-b", { status: 200 });
      },
    });

    await downloadStage({ urls: [url1, url2] }).run(makeCtx());

    expect(await readFile(targetPath(stagingDir, url1), "utf8")).toBe("previous");
    expect(await readFile(targetPath(stagingDir, url2), "utf8")).toBe("fresh-b");
    expect(url2Hit).toBe(true);
  });
});
