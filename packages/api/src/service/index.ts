import { search } from "./search";
import { reverse } from "./reverse";
import { getPlace } from "./places";
import { queryPostal } from "./postal";
import { listCountries, getCountry } from "./countries";
import { getCoverage } from "./coverage";
import { runBatch } from "./batch";
import { lookupByCode } from "./code";
import { random } from "./random";

export const service = {
  search,
  reverse,
  place: { get: getPlace },
  postal: { query: queryPostal },
  country: { list: listCountries, get: getCountry },
  coverage: { get: getCoverage },
  batch: { run: runBatch },
  code: { lookup: lookupByCode },
  random,
} as const;
