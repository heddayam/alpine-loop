import {
  classifyAccessValue,
  classifyHikingValue,
  classifyStatusValue,
  createArcGisAgencyAdapter,
} from "./arcgis.mjs";

function classifyNpsHiking(value, field) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (field.toLowerCase() === "opentopublic") {
    if (/^(n|no|false|0|closed)$/.test(normalized)) return "blocked";
    // Open-to-public alone is access/status evidence, not proof that foot use is allowed.
    return "unknown";
  }
  if (/hik|hiker|pedestrian|foot/.test(normalized)) return "allowed";
  return classifyHikingValue(value);
}

function classifyNpsAccess(value, field) {
  if (field.toLowerCase() !== "opentopublic") return classifyAccessValue(value);
  const normalized = String(value ?? "").trim().toLowerCase();
  if (/^(y|yes|true|1|open)$/.test(normalized)) return "public";
  // A temporarily closed public trail is not private property.
  return "unknown";
}

function classifyNpsStatus(value, field) {
  if (field.toLowerCase() !== "opentopublic") return classifyStatusValue(value);
  const normalized = String(value ?? "").trim().toLowerCase();
  if (/^(n|no|false|0|closed)$/.test(normalized)) return "closed";
  if (/^(y|yes|true|1|open)$/.test(normalized)) return "open";
  return "unknown";
}

export const NPS_SOURCE = Object.freeze({
  provider: "nps",
  label: "National Park Service Public Trails",
  url: "https://mapservices.nps.gov/arcgis/rest/services/NationalDatasets/NPS_Public_Trails/FeatureServer/0",
  idFields: ["featureid", "geometryid", "facassetid", "objectid"],
  updatedAtFields: ["editdate", "edit_date", "last_edited_date", "lastupdate"],
  nameFields: ["trlname", "maplabel", "trlaltname"],
  managerFields: ["unitname", "unit_name", "unitcode", "unit_code"],
  hikingFields: ["opentopublic", "trluse", "trailuse"],
  accessFields: ["opentopublic", "dataaccess", "publicaccess", "access"],
  statusFields: ["opentopublic", "trlstatus", "status", "seasonal"],
  surfaceFields: ["trlsurface", "trl_surface", "trail_surface", "surface"],
  lengthFields: [],
  defaultManager: "National Park Service",
  classifyHiking: classifyNpsHiking,
  classifyAccess: classifyNpsAccess,
  classifyStatus: classifyNpsStatus,
});

export const npsAdapter = createArcGisAgencyAdapter(NPS_SOURCE);
export const normalizeNpsFeature = npsAdapter.normalizeFeature;
export const normalizeNpsSnapshot = npsAdapter.normalizeSnapshot;

export default npsAdapter;
