import { join } from "node:path";
import { atomicWriter } from "../lib/atomicWrite";
import { csvRow } from "../lib/csv";
import { countryFlagEmoji } from "../lib/flag";
import type { Stage } from "./runner";

const HEADER = csvRow([
  "code",
  "code3",
  "name",
  "capital",
  "continent",
  "currency_code",
  "languages",
  "calling_code",
  "flag_emoji",
]);

/**
 * Parse GeoNames countryInfo.txt into a flat country CSV.
 *
 * The file is tab-separated with a header section of comment lines
 * starting with `#`. Layout (19 columns):
 *   0 ISO  1 ISO3  2 ISO-Numeric  3 fips  4 Country  5 Capital
 *   6 Area  7 Population  8 Continent  9 tld  10 CurrencyCode
 *   11 CurrencyName  12 Phone  13 Postal Format  14 Postal Regex
 *   15 Languages  16 geonameid  17 neighbours  18 EquivalentFipsCode
 *
 * We keep the fields the API needs. Languages comes as a semicolon-joined
 * string (e.g. "en-US;es-US"). Translations via alternateNames are deferred.
 */
export const countriesStage: Stage = {
  id: "countries",
  isDone: async (ctx) =>
    Bun.file(join(ctx.stagingDir, "countries.csv")).exists(),
  run: async (ctx) => {
    const input = join(ctx.stagingDir, "extracted", "countryInfo.txt");
    const output = join(ctx.stagingDir, "countries.csv");
    const text = await Bun.file(input).text();

    const writer = atomicWriter(output);
    let rows = 0;
    try {
      await writer.write(HEADER);
      for (const line of text.split("\n")) {
        if (!line || line.startsWith("#")) continue;
        const cols = line.split("\t");
        if (cols.length < 16) continue;

        const code = cols[0]!;
        const languages = (cols[15] ?? "")
          .split(",")
          .map((l) => l.trim())
          .filter(Boolean)
          .join(";");

        await writer.write(
          csvRow([
            code,
            cols[1] || null,
            cols[4] || null,
            cols[5] || null,
            cols[8] || null,
            cols[10] || null,
            languages || null,
            cols[12] || null,
            countryFlagEmoji(code) || null,
          ]),
        );
        rows++;
      }
      await writer.commit();
      ctx.log(`[countries] wrote ${rows} rows`);
    } catch (err) {
      await writer.abort();
      throw err;
    }
  },
};
