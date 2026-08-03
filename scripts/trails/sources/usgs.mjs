import {
  classifyHikingValue,
  createArcGisAgencyAdapter,
} from "./arcgis.mjs";

export const USGS_SOURCE = Object.freeze({
  provider: "usgs",
  label: "USGS National Digital Trails",
  url: "https://carto.nationalmap.gov/arcgis/rest/services/transportation/MapServer/37",
  idFields: ["permanentidentifier", "globalid", "sourcefeatureid", "objectid"],
  updatedAtFields: ["sourceeditdate", "publisheddate", "loaddate"],
  nameFields: ["name", "maplabel", "trailname", "trail_name"],
  managerFields: ["primarytrailmaintainer", "sourceoriginator", "manager", "managingagency"],
  hikingFields: ["hikerpedestrian"],
  accessFields: ["publicaccess", "public_access", "access"],
  statusFields: ["status", "trailstatus", "trlstatus", "route_status"],
  surfaceFields: ["trailsurface", "surface", "trail_surface", "trlsurface"],
  lengthFields: [
    { fields: ["lengthmiles"], unit: "miles" },
    // The service does not document NETWORKLENGTH's unit. Preserve the value
    // without guessing; downstream canonical length comes from geometry.
    { fields: ["networklength"], unit: "unknown" },
  ],
  classifyHiking(value) {
    return classifyHikingValue(value);
  },
});

export const usgsAdapter = createArcGisAgencyAdapter(USGS_SOURCE);
export const normalizeUsgsFeature = usgsAdapter.normalizeFeature;
export const normalizeUsgsSnapshot = usgsAdapter.normalizeSnapshot;

export default usgsAdapter;
