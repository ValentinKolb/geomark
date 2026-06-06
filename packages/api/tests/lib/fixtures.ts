/**
 * Synthetic CSV fixtures used by tests/loader/service/routes.
 *
 * Designed to make ranking/coverage assertions meaningful:
 *   - Berlin (PPLC, big population) competes against Berliner Straße
 *     (PPL, small) and Berliner Platz to test BM25 + tiebreaker.
 *   - München tests fuzzy match for "munchn" typo.
 *   - Lübeck tests umlauts / unaccent.
 *   - US has 2 cities + 1 address shard.
 *   - DE has 4 cities + 1 address shard.
 *   - FR has only countries-row (coverage = "none").
 */

export const PLACES_CSV =
  "geonameid,name,asciiname,latitude,longitude,feature_class,feature_code,country_code,admin1_code,admin2_code,population,elevation,timezone\n" +
  "2950159,Berlin,Berlin,52.52437,13.41053,P,PPLC,DE,16,00,3645000,34,Europe/Berlin\n" +
  "2867714,Munich,Munich,48.13743,11.57549,P,PPLA,DE,02,,1471000,520,Europe/Berlin\n" +
  "2944388,Berliner Straße,Berliner Strasse,52.50000,13.40000,P,PPL,DE,16,00,1000,30,Europe/Berlin\n" +
  "2879139,Lübeck,Luebeck,53.86893,10.68729,P,PPL,DE,01,,217198,15,Europe/Berlin\n" +
  "5128581,New York City,New York City,40.71427,-74.00597,P,PPL,US,NY,061,8175133,10,America/New_York\n" +
  "5391959,San Francisco,San Francisco,37.77493,-122.41942,P,PPLA2,US,CA,075,864816,16,America/Los_Angeles\n";

export const POSTAL_CSV =
  "country_code,postal_code,place_name,admin_name1,admin_code1,latitude,longitude\n" +
  "DE,10115,Berlin Mitte,Berlin,16,52.5326,13.3850\n" +
  "DE,80331,München Altstadt,Bayern,02,48.1374,11.5755\n" +
  "DE,23552,Lübeck,Schleswig-Holstein,01,53.866,10.687\n" +
  "US,10004,New York,New York,NY,40.6993,-74.0156\n" +
  "US,94115,San Francisco,California,CA,37.7858,-122.4378\n";

export const COUNTRIES_CSV =
  "code,code3,name,capital,continent,currency_code,languages,calling_code,flag_emoji\n" +
  "DE,DEU,Germany,Berlin,EU,EUR,de,49,🇩🇪\n" +
  "US,USA,United States,Washington,NA,USD,en-US;es-US;haw,1,🇺🇸\n" +
  "FR,FRA,France,Paris,EU,EUR,fr-FR;frp;br,33,🇫🇷\n";

export const ADDR_DE_CSV =
  "gid,latitude,longitude,house_number,street,unit,city,postcode,region,country_code\n" +
  "oa:de:1,52.52437,13.41053,12,Müllerstraße,,Berlin,10115,Berlin,DE\n" +
  "oa:de:2,52.51000,13.42000,5,Friedrichstraße,,Berlin,10117,Berlin,DE\n" +
  "oa:de:3,48.13700,11.57500,7a,Marienplatz,,München,80331,Bayern,DE\n";

export const ADDR_US_CSV =
  "gid,latitude,longitude,house_number,street,unit,city,postcode,region,country_code\n" +
  "oa:us:1,40.71427,-74.00597,1,Broadway,,New York,10004,NY,US\n" +
  "oa:us:2,37.77493,-122.41942,2300,Fillmore St,Apt 3,San Francisco,94115,CA,US\n";

/**
 * Synthetic aliases — exercises every kind code path:
 *   - localized name (de, fr, es, ja)
 *   - airport codes (iata, icao)
 *   - abbreviation
 *   - wikipedia link
 *   - postal variant
 *   - wikidata id
 * Berlin (2950159), München=Munich (2867714), New York City (5128581).
 */
export const ALIASES_CSV =
  "geonameid,kind,lang,value,is_preferred\n" +
  // Berlin: localized names + IATA + link
  "2950159,name,en,Berlin,1\n" +
  "2950159,name,de,Berlin,1\n" +
  "2950159,name,fr,Berlin,1\n" +
  "2950159,name,ja,ベルリン,0\n" +
  "2950159,iata,,BER,0\n" +
  "2950159,icao,,EDDB,0\n" +
  "2950159,link,,https://en.wikipedia.org/wiki/Berlin,0\n" +
  "2950159,wkdt,,Q64,0\n" +
  // München: localized names — this is the key UX win, "münchen" finds Munich
  "2867714,name,de,München,1\n" +
  "2867714,name,en,Munich,1\n" +
  "2867714,name,fr,Munich,0\n" +
  "2867714,name,it,Monaco di Baviera,0\n" +
  "2867714,name,es,Múnich,0\n" +
  "2867714,iata,,MUC,0\n" +
  "2867714,icao,,EDDM,0\n" +
  "2867714,abbr,,M,0\n" +
  "2867714,link,,https://en.wikipedia.org/wiki/Munich,0\n" +
  "2867714,post,,80331,0\n" +
  // NYC
  "5128581,name,en,New York City,1\n" +
  "5128581,abbr,,NYC,0\n" +
  "5128581,iata,,NYC,0\n" +
  "5128581,name,fr,New York,0\n" +
  "5128581,name,de,New York,0\n";
