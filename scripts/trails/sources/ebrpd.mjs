import { createArcGisAgencyAdapter } from "./arcgis.mjs";

export const EBRPD_SOURCE = Object.freeze({
  provider: "ebrpd",
  label: "East Bay Regional Park District Trails",
  url: "https://services2.arcgis.com/jeEP9c9zZoQQwtck/ArcGIS/rest/services/DistrictTrails_ByTrailName/FeatureServer/0",
  idFields: ["globalid", "trailid", "objectid", "fid"],
  updatedAtFields: ["last_edited_date", "edit_date", "updatedate"],
  nameFields: ["trailname", "name_1"],
  managerFields: ["name_1", "manager", "parkname", "park_name"],
  hikingFields: ["hikerpedestrian", "hiking", "trailuse"],
  accessFields: ["publicaccess", "access"],
  statusFields: ["status", "trailstatus", "opentopublic", "seasonal"],
  surfaceFields: ["surface", "trail_surface", "surf_type"],
  lengthFields: [{ fields: ["miles"], unit: "miles" }],
  defaultManager: "East Bay Regional Park District",
});

export const ebrpdAdapter = createArcGisAgencyAdapter(EBRPD_SOURCE);
export const normalizeEbrpdFeature = ebrpdAdapter.normalizeFeature;
export const normalizeEbrpdSnapshot = ebrpdAdapter.normalizeSnapshot;

export default ebrpdAdapter;
