import type { Attribution } from "@geomark/shared";

/**
 * Static attribution metadata for the data we redistribute. Hardcoded
 * because upstream licenses are stable per source and don't change with
 * dataset refreshes — the loader's manifest tracks dataset versions /
 * SHAs, this file tracks the legal contract for redistribution.
 *
 * If you swap a data source, update this file too.
 */
export const ATTRIBUTION: Attribution = {
  data_sources: [
    {
      name: "GeoNames",
      url: "https://www.geonames.org/",
      license: "CC BY 4.0",
      license_url: "https://creativecommons.org/licenses/by/4.0/",
      used_for: ["places", "postal_codes", "countries", "aliases"],
      attribution_text:
        "Source: GeoNames — https://www.geonames.org/ (CC BY 4.0)",
    },
    {
      name: "OpenAddresses",
      url: "https://openaddresses.io/",
      license: "Mixed (per-source: CC0 / CC BY / ODbL / public domain)",
      license_url: "https://github.com/openaddresses/openaddresses/blob/master/sources.csv",
      used_for: ["addresses"],
      attribution_text:
        "Source: OpenAddresses contributors — https://openaddresses.io/ — see per-source attribution at https://github.com/openaddresses/openaddresses/blob/master/sources.csv",
    },
  ],
  api_license: {
    name: "MIT",
    url: "https://opensource.org/licenses/MIT",
  },
  notice:
    "Geomark redistributes derived data from the upstream sources above " +
    "and is bound by their licenses. Downstream consumers must keep the " +
    "attribution intact when republishing.",
};
