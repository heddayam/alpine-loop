import type { AccessState } from "@/lib/graph/types";
import { ArcGisOfficialAccessAdapter, documentedValue, type ArcGisAuthorityDefinition } from "./arcgis";

export const EAST_BAY_REGIONAL_PARK_DISTRICT_QUERY_URL = "https://services2.arcgis.com/jeEP9c9zZoQQwtck/arcgis/rest/services/EBRPD_Roads_and_Trails/FeatureServer/13/query?where=PARK_NAME%20IN%20(%27Pleasanton%20Ridge%27%2C%27Mission%20Peak%27%2C%27Vargas%20Plateau%27%2C%27Sunol%27%2C%27Ohlone%27%2C%27Del%20Valle%27)&outFields=GlobalID%2CACCESS%2CPARK_NAME%2CLOCALNAME&returnGeometry=true&outSR=4326&f=json";

const ACCESS_VALUES = [
  "Foot",
  "Foot Bicycle",
  "Foot Horse",
  "Foot Horse Bicycle",
  "Service",
  "Horse",
  "Bicycle",
  "Foot Horse Bicycle Vehicle",
  "Foot Bicycle Vehicle",
  "EVMA",
] as const;

const FOOT_ACCESS_VALUES = new Set<string>([
  "Foot",
  "Foot Bicycle",
  "Foot Horse",
  "Foot Horse Bicycle",
  "Foot Horse Bicycle Vehicle",
  "Foot Bicycle Vehicle",
]);

export const eastBayRegionalParkDistrictDefinition: ArcGisAuthorityDefinition = {
  authority: "East Bay Regional Park District",
  dataset: "EBRPD Roads and Trails / Roads and Trails-by Access",
  queryUrl: EAST_BAY_REGIONAL_PARK_DISTRICT_QUERY_URL,
  objectIdField: "OBJECTID",
  stableIdField: "GlobalID",
  nameField: "LOCALNAME",
  expectedFields: {
    GlobalID: "esriFieldTypeGlobalID",
    ACCESS: "esriFieldTypeString",
    PARK_NAME: "esriFieldTypeString",
    LOCALNAME: "esriFieldTypeString",
  },
  resolve(attributes): AccessState {
    const access = documentedValue(attributes, "ACCESS", ACCESS_VALUES);
    if (access === null) return "unknown";
    return FOOT_ACCESS_VALUES.has(access) ? "public" : "prohibited";
  },
};

export class EastBayRegionalParkDistrictAccessAdapter extends ArcGisOfficialAccessAdapter {
  constructor() { super(eastBayRegionalParkDistrictDefinition); }
}
