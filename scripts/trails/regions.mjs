const regionDefinitions = [
  {
    id: "yosemite-stanislaus",
    label: "Yosemite–Stanislaus",
    bbox: [-120.1, 37.55, -119.35, 38.15],
    elevationProbe: { latitude: 37.7459, longitude: -119.5936 },
  },
  {
    id: "bay-midpen",
    label: "Bay Area — Midpen",
    bbox: [-122.25, 37.15, -121.95, 37.45],
    elevationProbe: { latitude: 37.1608, longitude: -121.9041 },
  },
  {
    id: "bay-east",
    label: "Bay Area — East Bay",
    bbox: [-122.1, 37.45, -121.75, 37.85],
    elevationProbe: { latitude: 37.5124, longitude: -121.8807 },
  },
  {
    id: "sierra-national-forest",
    label: "Sierra National Forest",
    bbox: [-119.35, 36.95, -118.85, 37.45],
    elevationProbe: { latitude: 37.2946, longitude: -119.1038 },
  },
  {
    id: "tahoe-eldorado",
    label: "Tahoe–Eldorado",
    bbox: [-120.4, 38.6, -119.85, 39.15],
    elevationProbe: { latitude: 38.9341, longitude: -120.0418 },
  },
];

function freezeRegion(region) {
  return Object.freeze({
    ...region,
    bbox: Object.freeze([...region.bbox]),
    elevationProbe: Object.freeze({ ...region.elevationProbe }),
  });
}

export const REGIONS = Object.freeze(regionDefinitions.map(freezeRegion));

export const YOSEMITE_STANISLAUS = REGIONS[0];
export const BAY_MIDPEN = REGIONS[1];
export const BAY_EAST = REGIONS[2];
export const SIERRA_NATIONAL_FOREST = REGIONS[3];
export const TAHOE_ELDORADO = REGIONS[4];

const regionsById = new Map(REGIONS.map((region) => [region.id, region]));

export function getRegion(regionId) {
  return regionsById.get(regionId);
}

export function requireRegion(regionId) {
  const region = getRegion(regionId);
  if (!region) {
    throw new RangeError(
      `Unknown trail region ${JSON.stringify(regionId)}; expected one of ${REGIONS.map(({ id }) => id).join(", ")}`,
    );
  }
  return region;
}

export default REGIONS;
