import { ArcGisOfficialAccessAdapter, type ArcGisAuthorityDefinition } from "./arcgis";

export const CALIFORNIA_STATE_PARKS_QUERY_URL = "https://services2.arcgis.com/AhxrK3F6WM8ECvDi/arcgis/rest/services/RecreationalRoutes/FeatureServer/0/query?where=1%3D1&outFields=FID%2CROUTENAME%2CGISID%2CROUTECLASS%2CUNITNAME%2CROUTECAT%2CROUTETYPE%2CGlobalID&returnGeometry=true&outSR=4326&f=json";

export const californiaStateParksDefinition: ArcGisAuthorityDefinition = {
  authority: "California State Parks",
  dataset: "Recreational Routes",
  queryUrl: CALIFORNIA_STATE_PARKS_QUERY_URL,
  objectIdField: "FID",
  stableIdField: "GISID",
  nameField: "ROUTENAME",
  expectedFields: {
    FID: "esriFieldTypeOID",
    ROUTENAME: "esriFieldTypeString",
    GISID: "esriFieldTypeString",
    ROUTECLASS: "esriFieldTypeString",
    UNITNAME: "esriFieldTypeString",
    ROUTECAT: "esriFieldTypeString",
    ROUTETYPE: "esriFieldTypeString",
    GlobalID: "esriFieldTypeGlobalID",
  },
  // The published schema describes recreational routes but no pedestrian or
  // closure field. Presence alone is not treated as permission.
  resolve: () => "unknown",
};

export class CaliforniaStateParksAccessAdapter extends ArcGisOfficialAccessAdapter {
  constructor() { super(californiaStateParksDefinition); }
}
