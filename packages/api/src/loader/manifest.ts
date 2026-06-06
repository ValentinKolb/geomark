import { z } from "zod";

const HEX_SHA256 = /^[a-f0-9]{64}$/;
const COUNTRY_CODE = /^[A-Z]{2}$/;

const FileEntrySchema = z.object({
  filename: z.string(),
  sha256: z.string().regex(HEX_SHA256),
  size_bytes: z.number().int().nonnegative(),
  line_count: z.number().int().nonnegative(),
});

const AddressFileEntrySchema = FileEntrySchema.extend({
  country_code: z.string().regex(COUNTRY_CODE),
});

const ManifestSchema = z.object({
  built_at: z.string(),
  version: z.string().min(1),
  license: z.record(z.string(), z.string()),
  files: z.object({
    places: FileEntrySchema,
    postal_codes: FileEntrySchema,
    countries: FileEntrySchema,
    addresses: z.array(AddressFileEntrySchema),
    /** Only present when the data builder ran with GEONAMES_ALIASES_URL set. */
    aliases: FileEntrySchema.optional(),
  }),
  coverage: z.record(z.string(), z.literal("address")),
  sources: z.object({
    geonames_cities_url: z.string().url(),
    geonames_postal_url: z.string().url(),
    geonames_country_info_url: z.string().url(),
    openaddresses_url: z.string().url(),
    geonames_aliases_url: z.string().url().optional(),
  }),
});

export type Manifest = z.infer<typeof ManifestSchema>;
type FileEntry = z.infer<typeof FileEntrySchema>;
export type AddressFileEntry = z.infer<typeof AddressFileEntrySchema>;

/** Fetch the data builder's manifest and validate it. */
export const fetchManifest = async (dataUrl: string): Promise<Manifest> => {
  const url = `${dataUrl.replace(/\/$/, "")}/latest.json`;
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`fetch ${url}: ${resp.status} ${resp.statusText}`);
  }
  const json = await resp.json();
  const result = ManifestSchema.safeParse(json);
  if (!result.success) {
    throw new Error(`invalid manifest at ${url}: ${result.error.message}`);
  }
  return result.data;
};
