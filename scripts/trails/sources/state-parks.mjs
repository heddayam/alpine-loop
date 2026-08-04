import { createArcGisAgencyAdapter } from "./arcgis.mjs";

export const STATE_PARKS_SOURCE = Object.freeze({
  provider: "state-parks",
  label: "California State Parks Recreational Routes",
  url: "https://services2.arcgis.com/AhxrK3F6WM8ECvDi/arcgis/rest/services/RecreationalRoutes/FeatureServer/0",
  // Complex statewide route geometry can make larger object-ID responses fail
  // at the hosted service edge even when the request URL itself is short.
  refreshPageSize: 50,
  idFields: ["globalid", "gisid", "fid", "objectid"],
  updatedAtFields: ["last_edited_date", "edit_date", "updatedate"],
  nameFields: ["routename", "unitname"],
  managerFields: ["unitname", "district", "manager"],
  hikingFields: ["hikerpedestrian", "hiking", "trailuse"],
  accessFields: ["publicaccess", "access"],
  statusFields: ["status", "route_status", "opentopublic", "seasonal"],
  surfaceFields: ["surface", "trail_surface", "routesur", "surf_type"],
  lengthFields: [{ fields: ["seglngth"], unit: "unknown" }],
  defaultManager: "California State Parks",
});

export const stateParksAdapter = createArcGisAgencyAdapter(STATE_PARKS_SOURCE);
export const normalizeStateParksFeature = stateParksAdapter.normalizeFeature;
export const normalizeStateParksSnapshot = stateParksAdapter.normalizeSnapshot;

export default stateParksAdapter;
