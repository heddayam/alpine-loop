import type { SearchQuery } from "../model.js";
import { DEFAULT_ROAD_LIMITS } from "../model.js";

export type UnitSystem = "imperial" | "metric";
const systems = {
  imperial: {
    distance: 1609.344,
    elevation: 0.3048,
    distanceLabel: "mi",
    elevationLabel: "ft",
    gainStep: 500,
  },
  metric: {
    distance: 1000,
    elevation: 1,
    distanceLabel: "km",
    elevationLabel: "m",
    gainStep: 100,
  },
} as const;
export const unitsFor = (system: UnitSystem) => systems[system];
export const distanceText = (meters: number, system: UnitSystem, digits = 1) =>
  (meters / systems[system].distance).toFixed(digits);
export const elevationText = (meters: number, system: UnitSystem) =>
  Math.round(meters / systems[system].elevation).toLocaleString();
export const stemDistance = (route: { distance: number; repetition: number }) =>
  route.distance * route.repetition;
/** Older saved searches limited the stem proportionally, so this is their upper bound. */
export const stemLimit = (query: SearchQuery) =>
  query.stem ?? query.distance[1] * (query.repetition ?? 0);
export const hasApproachLimit = (query: SearchQuery) =>
  query.stem !== undefined || query.repetition !== 1;
export const hasRoadLimit = (query: SearchQuery) => {
  const roads = query.roads ?? DEFAULT_ROAD_LIMITS;
  return roads.distance < query.distance[1] || roads.fraction < 1;
};

export function readUnitSystem(): UnitSystem {
  try {
    return localStorage.getItem("alpine-loop.units") === "metric"
      ? "metric"
      : "imperial";
  } catch {
    return "imperial";
  }
}
export function saveUnitSystem(system: UnitSystem) {
  try {
    localStorage.setItem("alpine-loop.units", system);
  } catch {
    // The current session still keeps the chosen units.
  }
}
