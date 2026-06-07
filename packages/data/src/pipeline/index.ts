import type { Stage, StageCtx } from "./runner";
import { runStages } from "./runner";
import { downloadStage } from "./01-download";
import { extractStage } from "./02-extract";
import { placesStage } from "./03-places";
import { addressesStage } from "./04-addresses";
import { postalStage } from "./05-postal";
import { countriesStage } from "./06-countries";
import { aliasesStage } from "./08-aliases";
import { publishStage } from "./07-publish";

export type PipelineConfig = {
  geonamesCitiesUrl: string;
  geonamesPostalUrl: string;
  geonamesCountryInfoUrl: string;
  openaddressesUrl: string;
  /** filename inside the cities zip, e.g. "cities500.txt" */
  citiesFilename: string;
  /** filename inside the postal zip, e.g. "allCountries.txt" or "DE.txt" */
  postalFilename: string;
  /**
   * If set, fetch GeoNames alternateNamesV2 (or compatible) and emit an
   * `aliases.csv` artefact. Disabled by default — the file is huge
   * (~250MB compressed, ~12M rows) and not all deployments need it.
   */
  geonamesAliasesUrl?: string;
  /** filename inside the aliases zip, e.g. "alternateNamesV2.txt". Required when `geonamesAliasesUrl` is set. */
  aliasesFilename?: string;
};

const composeStages = (cfg: PipelineConfig): Stage[] => {
  const downloads = [
    cfg.geonamesCitiesUrl,
    cfg.geonamesPostalUrl,
    cfg.geonamesCountryInfoUrl,
    cfg.openaddressesUrl,
  ];
  if (cfg.geonamesAliasesUrl) downloads.push(cfg.geonamesAliasesUrl);

  const stages: Stage[] = [
    downloadStage({ urls: downloads }),
    extractStage,
    placesStage(cfg.citiesFilename),
    addressesStage,
    postalStage(cfg.postalFilename),
    countriesStage,
  ];
  if (cfg.geonamesAliasesUrl) {
    if (!cfg.aliasesFilename) {
      throw new Error(
        "PipelineConfig: aliasesFilename is required when geonamesAliasesUrl is set",
      );
    }
    stages.push(aliasesStage(cfg.aliasesFilename));
  }
  stages.push(
    publishStage({
      geonames_cities_url: cfg.geonamesCitiesUrl,
      geonames_postal_url: cfg.geonamesPostalUrl,
      geonames_country_info_url: cfg.geonamesCountryInfoUrl,
      openaddresses_url: cfg.openaddressesUrl,
      ...(cfg.geonamesAliasesUrl
        ? { geonames_aliases_url: cfg.geonamesAliasesUrl }
        : {}),
    }),
  );
  return stages;
};

export const buildDataset = async (
  cfg: PipelineConfig,
  ctx: StageCtx,
): Promise<void> => {
  await runStages(composeStages(cfg), ctx);
};

export { runStages, composeStages };
export type { Stage, StageCtx } from "./runner";
