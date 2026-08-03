import {
  classifyHikingValue,
  createArcGisAgencyAdapter,
} from "./arcgis.mjs";

function classifyUsfsHiking(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return "unknown";
  if (/not accepted|prohibited|closed|^n$|^no$|^0$/.test(normalized)) return "blocked";
  // The publish layer's *_ACCPT fields describe accepted managed uses. A
  // populated non-negative value is the explicit hiking evidence audited in T0.
  if (/accepted|managed|hiker|pedestrian|^y$|^yes$|^1$/.test(normalized)) return "allowed";
  return classifyHikingValue(value);
}

export const USFS_SOURCE = Object.freeze({
  provider: "usfs",
  label: "US Forest Service NFS Trails",
  url: "https://apps.fs.usda.gov/ArcX/rest/services/EDW/EDW_TrailNFSPublish_01/MapServer/0",
  idFields: ["globalid", "trail_cn", "segment_cn", "objectid", "fid"],
  updatedAtFields: ["last_update", "last_updated_date", "edit_date", "last_edited_date"],
  nameFields: ["trail_name", "trail_no"],
  managerFields: ["managing_org", "admin_org", "forest_name", "forestname"],
  hikingFields: [
    "hiker_pedestrian_managed",
    "hiker_pedestrian_accpt",
    "hiker_pedestrian_accpt_disc",
  ],
  accessFields: ["public_access", "access_right", "access"],
  statusFields: ["trail_status", "status", "route_status"],
  surfaceFields: ["trail_surface", "terra_base_sym_desc", "surface", "trlsurface"],
  lengthFields: [
    { fields: ["gis_miles"], unit: "miles" },
    { fields: ["segment_length"], unit: "miles" },
  ],
  defaultManager: "US Forest Service",
  classifyHiking: classifyUsfsHiking,
});

export const usfsAdapter = createArcGisAgencyAdapter(USFS_SOURCE);
export const normalizeUsfsFeature = usfsAdapter.normalizeFeature;
export const normalizeUsfsSnapshot = usfsAdapter.normalizeSnapshot;

export default usfsAdapter;
