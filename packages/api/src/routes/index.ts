import type { Context } from "hono";
import { Hono } from "hono";
import { describeRoute, resolver, validator } from "hono-openapi";
import { z } from "zod";
import {
  AttributionSchema,
  BatchRequestSchema,
  BatchResponseSchema,
  CountrySchema,
  CountriesResponseSchema,
  CoverageResponseSchema,
  ErrorSchema,
  FeatureCollectionSchema,
  PlaceResponseSchema,
  PlaceSchema,
  PostalQuerySchema,
  PostalResponseSchema,
  RandomQuerySchema,
  RandomResponseSchema,
  ReverseQuerySchema,
  SearchQuerySchema,
} from "@geomark/shared";
import { ATTRIBUTION } from "../attribution";
import { ok } from "../lib/respond";
import { service } from "../service";
import { respond } from "../lib/respond";

// Validator failure hook: reshape standard-schema issues into our
// ErrorSchema `{ error, code }` so the documented contract holds.
const onInvalid = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  result: { success: boolean; error?: readonly any[]; data: unknown },
  c: Context,
): Response | undefined => {
  if (result.success) return undefined;
  const issues = (result.error ?? [])
    .map((i: { path?: readonly unknown[]; message: string }) => {
      const path = i.path
        ?.map((p) =>
          typeof p === "object" && p !== null && "key" in p
            ? (p as { key: string | number }).key
            : (p as string | number),
        )
        .join(".");
      return path ? `${path}: ${i.message}` : i.message;
    })
    .join("; ");
  return c.json(
    { error: `validation failed: ${issues}`, code: "BAD_INPUT" },
    400,
  );
};

// ─── helpers ─────────────────────────────────────────────────────────────────

const jsonResponse = (
  schema: z.ZodTypeAny,
  description: string,
) => ({
  description,
  content: { "application/json": { schema: resolver(schema) } },
});

// Shared error responses applied to every /v1/* route.
const COMMON_ERRORS = {
  400: jsonResponse(ErrorSchema, "Invalid input"),
  401: jsonResponse(ErrorSchema, "API key required"),
  429: jsonResponse(ErrorSchema, "Rate limit exceeded"),
  500: jsonResponse(ErrorSchema, "Server error"),
};

// Tag groups for Scalar's sidebar.
const TAG_SEARCH = "Search";
const TAG_LOOKUP = "Lookup";
const TAG_REFERENCE = "Reference";

// ─── routes ──────────────────────────────────────────────────────────────────

export const geoRoutes = new Hono()
  .get(
    "/search",
    describeRoute({
      tags: [TAG_SEARCH],
      summary: "Search by text",
      description:
        "Search places and addresses by free text. Tokenized matches rank above fuzzy ones. " +
        "Filter by `country`, `bbox`, or `proximity_lat`/`proximity_lng`. " +
        "Set `prefer_lang` to localize the returned name.",
      responses: {
        200: jsonResponse(FeatureCollectionSchema, "Ranked results"),
        ...COMMON_ERRORS,
      },
    }),
    validator("query", SearchQuerySchema, onInvalid),
    async (c) =>
      respond(c, () => service.search(c.req.valid("query"))),
  )
  .get(
    "/reverse",
    describeRoute({
      tags: [TAG_SEARCH],
      summary: "Search by coordinates",
      description:
        "Find places and addresses near a point. Results are ordered by spheroid distance and " +
        "capped to `radius` km (default 5).",
      responses: {
        200: jsonResponse(FeatureCollectionSchema, "Nearest features"),
        ...COMMON_ERRORS,
      },
    }),
    validator("query", ReverseQuerySchema, onInvalid),
    async (c) =>
      respond(c, () => service.reverse(c.req.valid("query"))),
  )
  .post(
    "/batch",
    describeRoute({
      tags: [TAG_SEARCH],
      summary: "Batch search/reverse",
      description:
        "Up to 100 search or reverse queries in one request. Per-entry errors return an empty " +
        "feature list for that slot — the call as a whole still succeeds.\n\n" +
        "For high-volume offline workloads, consider pulling the raw " +
        "datasets directly from https://geomark.dev/data and querying them locally " +
        "(GeoNames + OpenAddresses as compressed CSV).",
      responses: {
        200: jsonResponse(BatchResponseSchema, "Per-entry results"),
        ...COMMON_ERRORS,
      },
    }),
    validator("json", BatchRequestSchema, onInvalid),
    async (c) =>
      respond(c, () => service.batch.run(c.req.valid("json"))),
  )
  .get(
    "/place/:gid",
    describeRoute({
      tags: [TAG_LOOKUP],
      summary: "Get place by ID",
      description:
        "Returns a single place plus its `aliases` (alternate names, airport codes, Wikipedia URL, " +
        "postal variants). Aliases is an empty array when the dataset has no aliases artefact. " +
        "Global ID format: `geonames:<geonameid>`.",
      responses: {
        200: jsonResponse(PlaceResponseSchema, "Place with aliases"),
        404: jsonResponse(ErrorSchema, "Place not found"),
        ...COMMON_ERRORS,
      },
    }),
    validator("param", z.object({ gid: z.string().min(1) }), onInvalid),
    async (c) =>
      respond(c, () => service.place.get(c.req.valid("param").gid)),
  )
  .get(
    "/code/:kind/:value",
    describeRoute({
      tags: [TAG_LOOKUP],
      summary: "Lookup place by alternate code",
      description:
        "Find a place via an alternate code. Common kinds: `iata`, `icao`, `faac` (airport codes), " +
        "`abbr` (e.g. NYC), `wkdt` (Wikidata id), `name` (alternate names — may be ambiguous), " +
        "`post` (postal variant — may be ambiguous). " +
        "Case-insensitive on `value`. Requires the aliases dataset.",
      responses: {
        200: jsonResponse(PlaceSchema, "Matching place"),
        404: jsonResponse(ErrorSchema, "No place for that code"),
        ...COMMON_ERRORS,
      },
    }),
    validator(
      "param",
      z.object({
        kind: z.string().min(1).max(20).transform((s) => s.toLowerCase()),
        value: z.string().min(1).max(200),
      }),
      onInvalid,
    ),
    async (c) => {
      const { kind, value } = c.req.valid("param");
      return respond(c, () => service.code.lookup(kind, value));
    },
  )
  .get(
    "/postal",
    describeRoute({
      tags: [TAG_REFERENCE],
      summary: "Query postal codes",
      description:
        "Filter by `code` (exact), `place` (fuzzy match), and/or `country`. " +
        "At least one of `code` or `place` is required.",
      responses: {
        200: jsonResponse(PostalResponseSchema, "Matching postal codes"),
        ...COMMON_ERRORS,
      },
    }),
    validator("query", PostalQuerySchema, onInvalid),
    async (c) =>
      respond(c, () => service.postal.query(c.req.valid("query"))),
  )
  .get(
    "/countries",
    describeRoute({
      tags: [TAG_REFERENCE],
      summary: "List countries",
      description:
        "All countries known to the dataset, with metadata and a `place_count` of associated places.",
      responses: {
        200: jsonResponse(CountriesResponseSchema, "Country list"),
        ...COMMON_ERRORS,
      },
    }),
    async (c) => respond(c, () => service.country.list()),
  )
  .get(
    "/countries/:code",
    describeRoute({
      tags: [TAG_REFERENCE],
      summary: "Get country",
      description: "Country metadata for a 2-letter ISO 3166-1 alpha-2 code.",
      responses: {
        200: jsonResponse(CountrySchema, "Country"),
        404: jsonResponse(ErrorSchema, "Country not found"),
        ...COMMON_ERRORS,
      },
    }),
    validator("param", z.object({ code: z.string().regex(/^[A-Za-z]{2}$/) }), onInvalid),
    async (c) =>
      respond(c, () => service.country.get(c.req.valid("param").code)),
  )
  .get(
    "/coverage",
    describeRoute({
      tags: [TAG_REFERENCE],
      summary: "Coverage map",
      description:
        "Per-country: deepest available layer — `address`, `place_only`, or `none`.",
      responses: {
        200: jsonResponse(CoverageResponseSchema, "Coverage by country code"),
        ...COMMON_ERRORS,
      },
    }),
    async (c) => respond(c, () => service.coverage.get()),
  )
  .get(
    "/attribution",
    describeRoute({
      tags: [TAG_REFERENCE],
      summary: "Data sources & licenses",
      description:
        "Required reading if you redistribute Geomark output. Lists every " +
        "upstream data source, its license, and a ready-to-paste attribution " +
        "string. The data is licensed by the upstreams (mainly GeoNames " +
        "CC BY 4.0); Geomark redistributes under those same licenses.",
      responses: {
        200: jsonResponse(AttributionSchema, "Attribution and license info"),
        ...COMMON_ERRORS,
      },
    }),
    async (c) => respond(c, () => ok(ATTRIBUTION)),
  )
  .get(
    "/random",
    describeRoute({
      tags: [TAG_REFERENCE],
      summary: "Random sample",
      description:
        "Up to 5000 random places. Filter by `country` and/or " +
        "`min_population`. Useful for visualisations, sampling, and " +
        "testing — for production fanout consider downloading the raw " +
        "datasets at https://geomark.dev/data instead.",
      responses: {
        200: jsonResponse(RandomResponseSchema, "Random places"),
        ...COMMON_ERRORS,
      },
    }),
    validator("query", RandomQuerySchema, onInvalid),
    async (c) => respond(c, () => service.random(c.req.valid("query"))),
  );
