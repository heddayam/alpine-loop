import type { AccessState } from "@/lib/graph/types";
import { ArcGisOfficialAccessAdapter, documentedValue, type ArcGisAuthorityDefinition } from "./arcgis";

export const SANTA_CLARA_COUNTY_QUERY_URL = "https://services1.arcgis.com/4QPaqCJqF1UIaPbN/arcgis/rest/services/Santa_Clara_County_Parks_Trails/FeatureServer/1/query?where=distribution%3D%27Public%27&outFields=OBJECTID%2Ctrail_name%2Cpublic_use%2Cstatus%2Chiking_use%2Cdistribution%2CGlobalID&returnGeometry=true&outSR=4326&f=json";

const PUBLIC_USE = ["hiking", "hiking/bicycling", "hiking/equestrian", "hiking/equestrian/bicycling", "no public access", "restricted", "archery", "motorcycle only", "limited private access"];

export const santaClaraCountyDefinition: ArcGisAuthorityDefinition = {
  authority: "Santa Clara County Parks and Recreation",
  dataset: "Santa Clara County Parks Trails",
  queryUrl: SANTA_CLARA_COUNTY_QUERY_URL,
  objectIdField: "OBJECTID",
  stableIdField: "GlobalID",
  nameField: "trail_name",
  expectedFields: {
    OBJECTID: "esriFieldTypeOID",
    trail_name: "esriFieldTypeString",
    public_use: "esriFieldTypeString",
    status: "esriFieldTypeString",
    hiking_use: "esriFieldTypeString",
    distribution: "esriFieldTypeString",
    GlobalID: "esriFieldTypeGlobalID",
  },
  resolve(attributes): AccessState {
    const publicUse = documentedValue(attributes, "public_use", PUBLIC_USE);
    const status = documentedValue(attributes, "status", ["open", "temporarily closed", "closed"]);
    const hiking = documentedValue(attributes, "hiking_use", ["yes", "no"]);
    const distribution = documentedValue(attributes, "distribution", ["Internal Only", "Limited", "Public"]);
    if (distribution !== "Public") return "unknown";
    if (status === "temporarily closed" || status === "closed") return "closed";
    if (publicUse === "no public access" || publicUse === "archery" || publicUse === "motorcycle only" || hiking === "no") return "prohibited";
    if (publicUse === "limited private access") return "private";
    if (status === "open" && hiking === "yes" && publicUse?.includes("hiking")) return "public";
    return "unknown";
  },
};

export class SantaClaraCountyParksAccessAdapter extends ArcGisOfficialAccessAdapter {
  constructor() { super(santaClaraCountyDefinition); }
}
