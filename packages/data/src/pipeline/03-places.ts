import { join } from "node:path";
import { atomicWriter } from "../lib/atomicWrite";
import { csvRow } from "../lib/csv";
import { streamLines } from "../lib/lines";
import type { Stage } from "./runner";

const HEADER = csvRow([
  "geonameid",
  "name",
  "asciiname",
  "latitude",
  "longitude",
  "feature_class",
  "feature_code",
  "country_code",
  "admin1_code",
  "admin2_code",
  "population",
  "elevation",
  "timezone",
]);

/**
 * Parse a GeoNames cities export (cities500.txt or similar) into a flat
 * places CSV. The 19-column TSV layout is:
 *   0 geonameid  1 name  2 asciiname  3 alternatenames  4 lat  5 lng
 *   6 feature_class  7 feature_code  8 country_code  9 cc2
 *   10 admin1  11 admin2  12 admin3  13 admin4
 *   14 population  15 elevation  16 dem  17 timezone  18 modification_date
 */
export const placesStage = (citiesFilename: string): Stage => ({
  id: "places",
  isDone: async (ctx) =>
    Bun.file(join(ctx.stagingDir, "places.csv")).exists(),
  run: async (ctx) => {
    const input = join(ctx.stagingDir, "extracted", citiesFilename);
    const output = join(ctx.stagingDir, "places.csv");

    const writer = atomicWriter(output);
    let rows = 0;
    try {
      await writer.write(HEADER);
      for await (const line of streamLines(input)) {
        if (!line) continue;
        const cols = line.split("\t");
        if (cols.length < 19) continue;
        const geonameid = cols[0];
        if (!geonameid || !/^\d+$/.test(geonameid)) continue;

        await writer.write(
          csvRow([
            geonameid,
            cols[1] || null,
            cols[2] || null,
            cols[4] || null,
            cols[5] || null,
            cols[6] || null,
            cols[7] || null,
            cols[8] || null,
            cols[10] || null,
            cols[11] || null,
            cols[14] || null,
            cols[15] || null,
            cols[17] || null,
          ]),
        );
        rows++;
      }
      await writer.commit();
      ctx.log(`[places] wrote ${rows} rows`);
    } catch (err) {
      await writer.abort();
      throw err;
    }
  },
});
