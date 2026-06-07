import { join } from "node:path";
import { atomicWriter } from "../lib/atomicWrite";
import { csvRow, parseCsvLine } from "../lib/csv";
import { streamLines } from "../lib/lines";
import type { Stage } from "./runner";

const HEADER = csvRow([
  "geonameid",
  "kind",
  "lang",
  "value",
  "is_preferred",
]);

// Special isolanguage tags that aren't actual languages — bucket each as
// its own `kind` with NULL lang. Anything else (incl. empty) is "name".
const SPECIAL_KINDS = new Set([
  "abbr", "iata", "icao", "faac",
  "link", "post", "phon", "unlc", "wkdt",
]);

const SENTINEL = "aliases.done";

/**
 * Filter alternateNamesV2.txt to rows whose geonameid is present in
 * places.csv. Keeps file ~5–10× smaller than the raw 12M-row source.
 *
 * GeoNames TSV layout (10 columns):
 *   0 alternateNameId
 *   1 geonameid
 *   2 isolanguage
 *   3 alternate name
 *   4 isPreferredName
 *   5 isShortName
 *   6 isColloquial
 *   7 isHistoric
 *   8 from (period start)
 *   9 to   (period end)
 */
export const aliasesStage = (aliasesFilename: string): Stage => ({
  id: "aliases",
  isDone: async (ctx) =>
    Bun.file(join(ctx.stagingDir, SENTINEL)).exists(),
  run: async (ctx) => {
    const aliasInput = join(ctx.stagingDir, "extracted", aliasesFilename);
    const placesCsv = join(ctx.stagingDir, "places.csv");
    const output = join(ctx.stagingDir, "aliases.csv");

    // 1. Read all geonameids from places.csv into a Set for O(1) lookup.
    const placeIds = new Set<string>();
    let header: string[] | null = null;
    let geonameidCol = -1;
    for await (const line of streamLines(placesCsv)) {
      if (!line) continue;
      if (header === null) {
        header = parseCsvLine(line);
        geonameidCol = header.indexOf("geonameid");
        if (geonameidCol < 0) {
          throw new Error("places.csv missing 'geonameid' header");
        }
        continue;
      }
      const cols = parseCsvLine(line);
      const id = cols[geonameidCol];
      if (id) placeIds.add(id);
    }
    ctx.log(`[aliases] indexing ${placeIds.size} place ids for filter`);

    // 2. Stream alternateNamesV2.txt, filter, transform, write.
    const writer = atomicWriter(output);
    let kept = 0;
    let skipped = 0;
    try {
      await writer.write(HEADER);
      for await (const line of streamLines(aliasInput)) {
        if (!line) continue;
        const cols = line.split("\t");
        if (cols.length < 5) {
          skipped++;
          continue;
        }
        const geonameid = cols[1];
        if (!geonameid || !placeIds.has(geonameid)) {
          skipped++;
          continue;
        }
        const isolanguage = (cols[2] ?? "").trim();
        const value = cols[3] ?? "";
        if (!value) {
          skipped++;
          continue;
        }
        const isPreferred = cols[4] === "1" ? "1" : "0";

        let kind: string;
        let lang: string | null;
        if (SPECIAL_KINDS.has(isolanguage)) {
          kind = isolanguage;
          lang = null;
        } else {
          kind = "name";
          lang = isolanguage.length > 0 ? isolanguage : null;
        }

        await writer.write(csvRow([geonameid, kind, lang, value, isPreferred]));
        kept++;
      }
      await writer.commit();
      await Bun.write(join(ctx.stagingDir, SENTINEL), "");
      ctx.log(`[aliases] kept ${kept}, skipped ${skipped}`);
    } catch (err) {
      await writer.abort();
      throw err;
    }
  },
});
