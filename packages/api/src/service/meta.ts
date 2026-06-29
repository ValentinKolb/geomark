import { sql } from "bun";

const VERSION_CACHE_MS = 5_000;
let cachedVersion: { value: string; expiresAt: number } | null = null;

export const currentDatasetVersion = async (): Promise<string> => {
  const now = Date.now();
  if (cachedVersion && cachedVersion.expiresAt > now) {
    return cachedVersion.value;
  }
  const [row] = await sql<{ dataset_version: string | null }[]>`
    SELECT dataset_version FROM geomark.meta WHERE id = TRUE
  `;
  const value = row?.dataset_version ?? "unloaded";
  cachedVersion = { value, expiresAt: now + VERSION_CACHE_MS };
  return value;
};
