# @geomark/shared

Zod schemas and TypeScript types shared between `@geomark/api` (route
validation, OpenAPI generation) and `@geomark/web` (response typing).

Single export from `src/schemas.ts`. No runtime code beyond `z` definitions —
the package is essentially the contract between the API and any client built
from this repo.

## What's in here

| Schema | Used for |
|---|---|
| `SearchQuerySchema`, `ReverseQuerySchema`, `PostalQuerySchema`, `BatchRequestSchema`, `RandomQuerySchema` | Request validation |
| `FeatureSchema`, `FeatureCollectionSchema`, `PlaceSchema`, `PlaceResponseSchema`, `AddressSchema`, `PostalCodeSchema`, `CountrySchema`, `CoverageResponseSchema`, `BatchResponseSchema`, `RandomResponseSchema`, `AttributionSchema` | Response shapes (also exported as TypeScript types) |
| `ErrorSchema`, `HealthSchema` | Common envelopes |
| `AliasSchema`, `FeatureLayerSchema` | Sub-types |

All response schemas carry `.describe()` calls — these flow through
`hono-openapi` into the public OpenAPI spec at `/v1/openapi.json`.
