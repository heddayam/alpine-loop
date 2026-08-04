import type { AccessState } from "@/lib/graph/types";
import { ArcGisOfficialAccessAdapter, documentedValue, type ArcGisAuthorityDefinition } from "./arcgis";

export const MIDPEN_QUERY_URL = "https://services2.arcgis.com/qmhndvC947rDNl6t/arcgis/rest/services/Trail_(public)/FeatureServer/0/query?where=1%3D1&outFields=AssetID%2CNAME%2CTRLACCESS%2CHIKING%2CSEASCLOSE%2CGlobalID&returnGeometry=true&outSR=4326&f=json";

export const midpenDefinition: ArcGisAuthorityDefinition = {
  authority: "Midpeninsula Regional Open Space District",
  dataset: "Trail",
  queryUrl: MIDPEN_QUERY_URL,
  objectIdField: "OBJECTID",
  stableIdField: "AssetID",
  nameField: "NAME",
  expectedFields: {
    AssetID: "esriFieldTypeString",
    NAME: "esriFieldTypeString",
    TRLACCESS: "esriFieldTypeString",
    HIKING: "esriFieldTypeString",
    SEASCLOSE: "esriFieldTypeString",
    GlobalID: "esriFieldTypeGlobalID",
  },
  resolve(attributes): AccessState {
    const access = documentedValue(attributes, "TRLACCESS", ["Public", "Permit", "Private", "Authorized Persons", "Other", "Unknown"]);
    const hiking = documentedValue(attributes, "HIKING", ["Yes", "No", "Unknown", "N/A"]);
    const seasonal = documentedValue(attributes, "SEASCLOSE", ["Yes", "No", "Unknown", "N/A"]);
    if (seasonal === "Yes") return "closed";
    if (hiking === "No" || access === "Authorized Persons") return "prohibited";
    if (access === "Private") return "private";
    if (access === "Public" && hiking === "Yes") return "public";
    return "unknown";
  },
};

export class MidpenOfficialAccessAdapter extends ArcGisOfficialAccessAdapter {
  constructor() { super(midpenDefinition); }
}
