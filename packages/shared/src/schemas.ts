import { z } from "zod";

// ─── Attribution ─────────────────────────────────────────────────────────────

export const DataSourceSchema = z
  .object({
    name: z.string().describe("Source name as it should appear in attribution."),
    url: z.string().url().describe("Project home page."),
    license: z.string().describe("License identifier or short summary."),
    license_url: z.string().url().describe("Link to the full license text or terms page."),
    used_for: z
      .array(z.string())
      .describe("Which Geomark data tables come from this source (places, addresses, ...)."),
    attribution_text: z.string().describe(
      "Ready-to-paste credit string. Use this verbatim when redistributing.",
    ),
  })
  .describe("One upstream data source.");

export const AttributionSchema = z
  .object({
    data_sources: z.array(DataSourceSchema),
    api_license: z
      .object({
        name: z.string(),
        url: z.string().url(),
      })
      .describe("License governing the API code itself (separate from the data)."),
    notice: z.string().describe("Plain-English notice for redistributors."),
  })
  .describe("Data attribution and licensing for this Geomark deployment.");

// ─── Common ──────────────────────────────────────────────────────────────────

export const ErrorSchema = z
  .object({
    error: z.string().describe("Human-readable error message."),
    code: z.string().optional().describe("Stable machine-readable error code."),
  })
  .describe("Error response.");

export const HealthSchema = z
  .object({
    status: z.literal("ok"),
    places_count: z.number().int(),
    addresses_count: z.number().int(),
    postal_codes_count: z.number().int(),
    data_loaded_at: z.string().nullable(),
  })
  .describe("API health and dataset state.");

// ─── Alias (multilingual / IATA / wikilink / postal metadata) ────────────────

export const AliasSchema = z
  .object({
    kind: z.string().describe(
      "Type of alias. Known values: `name`, `abbr`, `iata`, `icao`, `faac`, `link`, `post`, `phon`, `unlc`, `wkdt`. Unknown values are passed through as opaque strings.",
    ),
    lang: z.string().nullable().describe(
      "ISO 639-1 or 639-3 language code. Null for non-language kinds (codes, links, postal variants).",
    ),
    value: z.string().describe("Alias text, code, or URL."),
    is_preferred: z.boolean().describe(
      "True if marked as the official or preferred form for its kind+lang.",
    ),
  })
  .describe("Alternate name or metadata code for a place.");

// ─── Place (GeoNames-backed) ─────────────────────────────────────────────────

export const PlaceSchema = z
  .object({
    gid: z.string().describe("Global ID. Format: `geonames:<geonameid>`."),
    name: z.string().describe("Canonical place name (international form)."),
    asciiname: z.string().nullable().describe("ASCII-only variant of `name`."),
    latitude: z.number(),
    longitude: z.number(),
    feature_class: z.string().nullable().describe(
      "GeoNames feature class. `P` = populated place.",
    ),
    feature_code: z.string().nullable().describe(
      "GeoNames feature code (e.g. `PPLC` capital, `PPL` populated place).",
    ),
    country_code: z.string().nullable().describe("ISO 3166-1 alpha-2."),
    admin1_code: z.string().nullable(),
    admin2_code: z.string().nullable(),
    population: z.number().int().nullable(),
    elevation: z.number().int().nullable().describe("Meters above sea level."),
    timezone: z.string().nullable().describe("IANA timezone, e.g. `Europe/Berlin`."),
  })
  .describe("A populated place (city, town, region) from GeoNames.");

// ─── Address (OpenAddresses-backed) ──────────────────────────────────────────

export const AddressSchema = z
  .object({
    gid: z.string().describe("Global ID. Format: `oa:<cc>:<hash>`."),
    latitude: z.number(),
    longitude: z.number(),
    house_number: z.string().nullable(),
    street: z.string().nullable(),
    unit: z.string().nullable(),
    city: z.string().nullable(),
    postcode: z.string().nullable(),
    region: z.string().nullable(),
    country_code: z.string().nullable().describe("ISO 3166-1 alpha-2."),
  })
  .describe("A street address from OpenAddresses.");

// ─── Postal Code ─────────────────────────────────────────────────────────────

export const PostalCodeSchema = z
  .object({
    country_code: z.string().describe("ISO 3166-1 alpha-2."),
    postal_code: z.string(),
    place_name: z.string().nullable().describe("Place this postal code is associated with."),
    admin_name1: z.string().nullable().describe("State / province / region name."),
    admin_code1: z.string().nullable().describe("State / province / region code."),
    latitude: z.number().nullable(),
    longitude: z.number().nullable(),
  })
  .describe("A postal code entry from GeoNames.");

// ─── Country ─────────────────────────────────────────────────────────────────

export const CountrySchema = z
  .object({
    code: z.string().describe("ISO 3166-1 alpha-2."),
    code3: z.string().nullable().describe("ISO 3166-1 alpha-3."),
    name: z.string(),
    capital: z.string().nullable(),
    continent: z.string().nullable().describe("2-letter continent code (EU, NA, AS, ...)."),
    currency_code: z.string().nullable().describe("ISO 4217."),
    languages: z.array(z.string()).describe("BCP 47 language tags."),
    calling_code: z.string().nullable().describe("International dialling code."),
    flag_emoji: z.string().nullable(),
    place_count: z.number().int().describe("Number of places associated with this country."),
  })
  .describe("Country metadata.");

export const FeatureLayerSchema = z.enum(["address", "locality"]).describe(
  "Result type. `locality` = a populated place (city, town). `address` = a street address.",
);

export const FeatureSchema = z
  .object({
    gid: z.string().describe("Global ID — `geonames:N` or `oa:cc:hash`."),
    layer: FeatureLayerSchema,
    name: z.string().describe("Short display name."),
    label: z.string().describe("Full human-readable label."),
    latitude: z.number(),
    longitude: z.number(),
    country_code: z.string().nullable().describe("ISO 3166-1 alpha-2."),
    score: z.number().describe(
      "Relevance score, higher is better. Forward queries: token + fuzzy match strength. Reverse: closeness in [0, 1].",
    ),
    distance_km: z
      .number()
      .optional()
      .describe(
        "Distance from the query point. Always set for reverse; set for search when `proximity_lat`/`proximity_lng` are passed.",
      ),
    matched_alias: z
      .object({
        kind: z.string(),
        lang: z.string().nullable(),
        value: z.string(),
      })
      .optional()
      .describe(
        "Set when the match was via an alternate name. For example `?q=München` returns canonical Munich with `matched_alias = { kind: 'name', lang: 'de', value: 'München' }`.",
      ),
  })
  .describe("A search or reverse result feature.");

// ─── Query Schemas ───────────────────────────────────────────────────────────

// Reject empty strings before coercion (stock z.coerce.number() turns "" into 0).
const numericQueryParam = (label: string) =>
  z
    .string()
    .min(1, `${label} must not be empty`)
    .transform((s, ctx) => {
      const n = Number(s);
      if (!Number.isFinite(n)) {
        ctx.addIssue({ code: "custom", message: `${label} must be a number` });
        return z.NEVER;
      }
      return n;
    });

const latitudeParam = (label: string) =>
  numericQueryParam(label).pipe(z.number().min(-90).max(90));

const longitudeParam = (label: string) =>
  numericQueryParam(label).pipe(z.number().min(-180).max(180));

const positiveIntParam = (label: string, min: number, max: number) =>
  numericQueryParam(label).pipe(z.number().int().min(min).max(max));

const layersParam = z
  .string()
  .optional()
  .transform((v, ctx) => {
    if (!v) return undefined;
    const parts = v
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (parts.length === 0) return undefined;
    const layers: ("address" | "locality")[] = [];
    for (const p of parts) {
      const r = FeatureLayerSchema.safeParse(p);
      if (!r.success) {
        ctx.addIssue({ code: "custom", message: `invalid layer: ${p}` });
        return z.NEVER;
      }
      layers.push(r.data);
    }
    return layers;
  })
  .describe("Comma-separated layer filter, e.g. `address,locality`. Defaults to all layers.");

const bboxParam = z
  .string()
  .optional()
  .transform((v, ctx) => {
    if (!v) return undefined;
    const parts = v.split(",").map((s) => Number(s.trim()));
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
      ctx.addIssue({
        code: "custom",
        message: "bbox must be minLng,minLat,maxLng,maxLat",
      });
      return z.NEVER;
    }
    const [minLng, minLat, maxLng, maxLat] = parts as [
      number, number, number, number,
    ];
    if (
      minLng < -180 || maxLng > 180 ||
      minLat < -90  || maxLat > 90 ||
      minLng > maxLng || minLat > maxLat
    ) {
      ctx.addIssue({
        code: "custom",
        message: "bbox out of range or inverted",
      });
      return z.NEVER;
    }
    return { minLng, minLat, maxLng, maxLat };
  })
  .describe("Bounding box `minLng,minLat,maxLng,maxLat`, all in decimal degrees.");

export const SearchQuerySchema = z
  .object({
    q: z.string().min(1).max(200).describe("Free-text query, 1–200 chars."),
    layers: layersParam,
    country: z
      .string()
      .regex(/^[A-Za-z]{2}$/, "country must be a 2-letter ISO code")
      .transform((s) => s.toUpperCase())
      .optional()
      .describe("Restrict results to one ISO 3166-1 alpha-2 country."),
    prefer_lang: z
      .string()
      .regex(/^[A-Za-z]{2,3}$/, "prefer_lang must be a 2- or 3-letter language code")
      .transform((s) => s.toLowerCase())
      .optional()
      .describe(
        "ISO 639-1/3 language code. If a localized alternate name exists for a result, `name` and `label` use it instead of the canonical name.",
      ),
    proximity_lat: latitudeParam("proximity_lat").optional().describe(
      "Bias results towards this latitude. Must be set together with `proximity_lng`.",
    ),
    proximity_lng: longitudeParam("proximity_lng").optional().describe(
      "Bias results towards this longitude. Must be set together with `proximity_lat`.",
    ),
    bbox: bboxParam,
    limit: positiveIntParam("limit", 1, 50).optional().describe("Max results, 1–50. Default 10."),
  })
  .refine(
    (d) =>
      (d.proximity_lat === undefined) === (d.proximity_lng === undefined),
    { message: "proximity_lat and proximity_lng must be set together" },
  );

export const ReverseQuerySchema = z.object({
  lat: latitudeParam("lat").describe("Latitude in decimal degrees, -90 to 90."),
  lng: longitudeParam("lng").describe("Longitude in decimal degrees, -180 to 180."),
  layers: layersParam,
  radius: numericQueryParam("radius")
    .pipe(z.number().positive().max(100))
    .optional()
    .describe("Search radius in km. Default 5, max 100."),
  limit: positiveIntParam("limit", 1, 50).optional().describe("Max results, 1–50. Default 10."),
});

export const PostalQuerySchema = z
  .object({
    code: z.string().min(1).optional().describe("Exact postal code match."),
    place: z.string().min(1).optional().describe("Fuzzy match on the associated place name."),
    country: z
      .string()
      .regex(/^[A-Za-z]{2}$/, "country must be a 2-letter ISO code")
      .transform((s) => s.toUpperCase())
      .optional()
      .describe("Restrict to one ISO 3166-1 alpha-2 country."),
    limit: positiveIntParam("limit", 1, 100).optional().describe("Max results, 1–100. Default 20."),
  })
  .refine((d) => d.code !== undefined || d.place !== undefined, {
    message: "at least one of `code` or `place` must be provided",
  });

// ─── Batch ───────────────────────────────────────────────────────────────────

export const BatchSearchEntrySchema = z
  .object({
    type: z.literal("search"),
    q: z.string().min(1).max(200),
    layers: z.array(FeatureLayerSchema).optional(),
    country: z.string().optional(),
    limit: z.number().int().min(1).max(10).optional().describe("Per-entry max, 1–10. Default 10."),
  })
  .describe("A search entry inside a batch request.");

export const BatchReverseEntrySchema = z
  .object({
    type: z.literal("reverse"),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    layers: z.array(FeatureLayerSchema).optional(),
    radius: z.number().positive().max(100).optional().describe("Search radius in km."),
    limit: z.number().int().min(1).max(10).optional().describe("Per-entry max, 1–10. Default 10."),
  })
  .describe("A reverse entry inside a batch request.");

export const BatchRequestSchema = z
  .object({
    entries: z
      .array(z.discriminatedUnion("type", [BatchSearchEntrySchema, BatchReverseEntrySchema]))
      .min(1)
      .max(100)
      .describe("1–100 search or reverse entries."),
  })
  .describe("Batch request body.");

// ─── Response Schemas ────────────────────────────────────────────────────────

export const FeatureCollectionSchema = z
  .object({
    features: z.array(FeatureSchema),
    total: z.number().int().describe("Number of features in `features`."),
  })
  .describe("Search or reverse result set.");

export const PlaceResponseSchema = z
  .object({
    place: PlaceSchema,
    aliases: z
      .array(AliasSchema)
      .default([])
      .describe(
        "All alternate names and codes for this place. Empty array when the dataset has no aliases artefact.",
      ),
  })
  .describe("A place plus its aliases.");

export const PostalResponseSchema = z
  .object({
    postal_codes: z.array(PostalCodeSchema),
    total: z.number().int(),
  })
  .describe("Postal code query results.");

export const CountriesResponseSchema = z
  .object({
    countries: z.array(CountrySchema),
    total: z.number().int(),
  })
  .describe("All countries in the dataset.");

export const CoverageResponseSchema = z
  .object({
    countries: z.record(z.string(), z.enum(["address", "place_only", "none"])).describe(
      "ISO 3166-1 alpha-2 → deepest available layer.",
    ),
  })
  .describe("Per-country data coverage.");

export const BatchResponseSchema = z
  .object({
    results: z.array(FeatureCollectionSchema).describe(
      "Same length and order as the request `entries`.",
    ),
  })
  .describe("Batch query results.");

// ─── Random ──────────────────────────────────────────────────────────────────

export const RandomQuerySchema = z.object({
  limit: positiveIntParam("limit", 1, 5000)
    .optional()
    .describe("How many random places to return, 1–5000. Default 500."),
  country: z
    .string()
    .regex(/^[A-Za-z]{2}$/, "country must be a 2-letter ISO code")
    .transform((s) => s.toUpperCase())
    .optional()
    .describe("Restrict to one ISO 3166-1 alpha-2 country."),
  min_population: positiveIntParam("min_population", 0, 100_000_000)
    .optional()
    .describe("Only places with population ≥ this value."),
});

export const RandomPlaceSchema = z
  .object({
    gid: z.string().describe("Global ID — `geonames:N`."),
    name: z.string(),
    latitude: z.number(),
    longitude: z.number(),
    country_code: z.string().nullable().describe("ISO 3166-1 alpha-2."),
    population: z
      .number()
      .nullable()
      .describe("Population if known, null otherwise."),
  })
  .describe("A place from the random sample.");

export const RandomResponseSchema = z
  .object({
    places: z.array(RandomPlaceSchema),
    total: z.number().describe("Number of places returned."),
  })
  .describe(
    "Random sample of places from the dataset. Useful for visualizations and testing.",
  );

// ─── Inferred Types ──────────────────────────────────────────────────────────

export type Attribution = z.infer<typeof AttributionSchema>;
export type Alias = z.infer<typeof AliasSchema>;
export type Place = z.infer<typeof PlaceSchema>;
export type Address = z.infer<typeof AddressSchema>;
export type PostalCode = z.infer<typeof PostalCodeSchema>;
export type Country = z.infer<typeof CountrySchema>;
export type Feature = z.infer<typeof FeatureSchema>;
export type FeatureLayer = z.infer<typeof FeatureLayerSchema>;
export type RandomPlace = z.infer<typeof RandomPlaceSchema>;
export type RandomResponse = z.infer<typeof RandomResponseSchema>;
export type RandomQuery = z.infer<typeof RandomQuerySchema>;
