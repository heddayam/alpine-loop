import {
  cloneLineString,
  validateCoordinate,
  validateLineString,
} from "./geometry.mjs";
import { geodesicDistanceMeters } from "./length.mjs";

const DEFAULT_AMBIGUITY_TOLERANCE_METERS = 0.001;

function candidateCoordinate(candidate, path) {
  if (Array.isArray(candidate)) return validateCoordinate(candidate, path);
  if (!candidate || typeof candidate !== "object") {
    throw new TypeError(`${path} must be a coordinate or candidate object`);
  }
  if (Array.isArray(candidate.coordinate)) {
    return validateCoordinate(candidate.coordinate, `${path}.coordinate`);
  }
  if (Array.isArray(candidate.coordinates)) {
    return validateCoordinate(candidate.coordinates, `${path}.coordinates`);
  }
  if (candidate.geometry?.type === "Point") {
    return validateCoordinate(candidate.geometry.coordinates, `${path}.geometry.coordinates`);
  }
  return validateCoordinate(
    [candidate.longitude, candidate.latitude],
    `${path} longitude/latitude`,
  );
}

function normalizedCandidates(candidates) {
  if (!Array.isArray(candidates)) throw new TypeError("candidates must be an array");
  const normalized = candidates.map((candidate, index) => {
    const coordinate = candidateCoordinate(candidate, `candidates[${index}]`);
    const suppliedId = !Array.isArray(candidate) ? candidate.id : undefined;
    const id = suppliedId === undefined
      ? `coordinate:${JSON.stringify(coordinate)}`
      : String(suppliedId).trim();
    if (!id) throw new TypeError(`candidates[${index}].id must be a non-empty value`);
    return { id, coordinate: [...coordinate] };
  });

  const ids = new Set();
  for (const candidate of normalized) {
    if (ids.has(candidate.id)) {
      throw new TypeError(`candidate id must be unique: ${candidate.id}`);
    }
    ids.add(candidate.id);
  }
  return normalized;
}

function validateOptions({ toleranceMeters, ambiguityToleranceMeters }) {
  if (!Number.isFinite(toleranceMeters) || toleranceMeters < 0) {
    throw new TypeError("toleranceMeters must be a non-negative finite number");
  }
  if (!Number.isFinite(ambiguityToleranceMeters) || ambiguityToleranceMeters < 0) {
    throw new TypeError("ambiguityToleranceMeters must be a non-negative finite number");
  }
}

/**
 * Find a unique nearest candidate within an explicit meter tolerance.
 * Equidistant candidates are returned as an ordered ambiguity and are never
 * silently resolved by input order or candidate ID.
 */
export function findSnapCandidate(
  endpoint,
  candidates,
  {
    toleranceMeters,
    ambiguityToleranceMeters = DEFAULT_AMBIGUITY_TOLERANCE_METERS,
  } = {},
) {
  validateCoordinate(endpoint, "endpoint");
  validateOptions({ toleranceMeters, ambiguityToleranceMeters });

  const matches = normalizedCandidates(candidates)
    .map((candidate) => ({
      ...candidate,
      distanceMeters: geodesicDistanceMeters(endpoint, candidate.coordinate),
    }))
    .filter(({ distanceMeters }) => distanceMeters <= toleranceMeters)
    .sort((left, right) => left.distanceMeters - right.distanceMeters ||
      left.id.localeCompare(right.id));

  if (matches.length === 0) {
    return { status: "none", coordinate: [...endpoint] };
  }

  const nearestDistance = matches[0].distanceMeters;
  const tied = matches.filter(
    ({ distanceMeters }) => distanceMeters - nearestDistance <= ambiguityToleranceMeters,
  );
  if (tied.length > 1) {
    return {
      status: "ambiguous",
      coordinate: [...endpoint],
      candidates: tied,
    };
  }

  return {
    status: "snapped",
    candidateId: matches[0].id,
    coordinate: [...matches[0].coordinate],
    distanceMeters: matches[0].distanceMeters,
  };
}

export const findEndpointSnap = findSnapCandidate;
export const snapEndpoint = findSnapCandidate;

/**
 * Snap each endpoint independently. Unique matches replace endpoint XY while
 * preserving any altitude/additional ordinates from the source endpoint.
 * Ambiguous and out-of-range endpoints remain unchanged.
 */
export function snapLineStringEndpoints(geometry, candidates, options) {
  validateLineString(geometry);
  const snappedGeometry = cloneLineString(geometry);
  const lastIndex = snappedGeometry.coordinates.length - 1;
  const start = findSnapCandidate(snappedGeometry.coordinates[0], candidates, options);
  const end = findSnapCandidate(snappedGeometry.coordinates[lastIndex], candidates, options);

  if (start.status === "snapped") {
    snappedGeometry.coordinates[0] = [
      start.coordinate[0],
      start.coordinate[1],
      ...snappedGeometry.coordinates[0].slice(2),
    ];
  }
  if (end.status === "snapped") {
    snappedGeometry.coordinates[lastIndex] = [
      end.coordinate[0],
      end.coordinate[1],
      ...snappedGeometry.coordinates[lastIndex].slice(2),
    ];
  }

  return {
    geometry: snappedGeometry,
    endpoints: { start, end },
    ambiguities: [
      ...(start.status === "ambiguous" ? [{ endpoint: "start", ...start }] : []),
      ...(end.status === "ambiguous" ? [{ endpoint: "end", ...end }] : []),
    ],
  };
}

export const snapEndpoints = snapLineStringEndpoints;
