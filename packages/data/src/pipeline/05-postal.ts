import { join } from "node:path";
import { atomicWriter } from "../lib/atomicWrite";
import { csvRow } from "../lib/csv";
import { streamLines } from "../lib/lines";
import type { Stage } from "./runner";

const HEADER = csvRow([
  "country_code",
  "postal_code",
  "place_name",
  "admin_name1",
  "admin_code1",
  "latitude",
  "longitude",
]);

/**
 * Parse GeoNames postal codes (allCountries.txt) into a clean CSV.
 *
 * GeoNames TSV layout (12 columns):
 *   0 country_code, 1 postal_code, 2 place_name, 3 admin_name1, 4 admin_code1,
 *   5 admin_name2, 6 admin_code2, 7 admin_name3, 8 admin_code3,
 *   9 latitude, 10 longitude, 11 accuracy
 *
 * We keep what the API actually queries against. admin_2/3 and accuracy are
 * dropped — re-add them later if a use case appears.
 */
export const postalStage = (postalFilename: string): Stage => ({
  id: "postal",
  isDone: async (ctx) =>
    Bun.file(join(ctx.stagingDir, "postal_codes.csv")).exists(),
  run: async (ctx) => {
    const input = join(ctx.stagingDir, "extracted", postalFilename);
    const output = join(ctx.stagingDir, "postal_codes.csv");

    const writer = atomicWriter(output);
    let rows = 0;
    try {
      await writer.write(HEADER);
      for await (const line of streamLines(input)) {
        if (!line) continue;
        const cols = line.split("\t");
        if (cols.length < 11) continue;
        await writer.write(
          csvRow([
            cols[0],
            cols[1],
            cols[2] || null,
            cols[3] || null,
            cols[4] || null,
            cols[9] || null,
            cols[10] || null,
          ]),
        );
        rows++;
      }
      await writer.commit();
      ctx.log(`[postal] wrote ${rows} rows`);
    } catch (err) {
      await writer.abort();
      throw err;
    }
  },
});
