import {
  validateLineString as validateCanonicalLineString,
  validatePosition as validateCanonicalPosition,
} from "../model.mjs";

function clonePosition(position) {
  return [...position];
}

function comparePositions(left, right) {
  const count = Math.max(left.length, right.length);
  for (let index = 0; index < count; index += 1) {
    if (left[index] === undefined) return -1;
    if (right[index] === undefined) return 1;
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return 0;
}

function squaredPlanarDistanceToSegment(position, start, end) {
  const referenceLatitude = ((start[1] + end[1] + position[1]) / 3) * Math.PI / 180;
  const longitudeScale = Math.cos(referenceLatitude);
  const deltaLongitude = (longitude) => {
    let delta = longitude - start[0];
    if (delta > 180) delta -= 360;
    if (delta < -180) delta += 360;
    return delta;
  };

  // A local equirectangular projection is stable for trail-sized segments.
  // Scaling is unnecessary here because the caller only compares distances.
  const pointX = deltaLongitude(position[0]) * longitudeScale;
  const pointY = position[1] - start[1];
  const endX = deltaLongitude(end[0]) * longitudeScale;
  const endY = end[1] - start[1];
  const segmentLengthSquared = endX ** 2 + endY ** 2;

  if (segmentLengthSquared === 0) return pointX ** 2 + pointY ** 2;

  const projection = Math.max(
    0,
    Math.min(1, (pointX * endX + pointY * endY) / segmentLengthSquared),
  );
  const differenceX = pointX - projection * endX;
  const differenceY = pointY - projection * endY;
  return differenceX ** 2 + differenceY ** 2;
}

function simplifyCoordinates(coordinates, squaredTolerance) {
  const retained = new Set([0, coordinates.length - 1]);
  const ranges = [[0, coordinates.length - 1]];

  while (ranges.length > 0) {
    const [first, last] = ranges.pop();
    let greatestDistance = squaredTolerance;
    let greatestIndex;

    for (let index = first + 1; index < last; index += 1) {
      const squaredDistance = squaredPlanarDistanceToSegment(
        coordinates[index],
        coordinates[first],
        coordinates[last],
      );
      if (squaredDistance > greatestDistance) {
        greatestDistance = squaredDistance;
        greatestIndex = index;
      }
    }

    if (greatestIndex === undefined) continue;
    retained.add(greatestIndex);
    if (greatestIndex - first > 1) ranges.push([first, greatestIndex]);
    if (last - greatestIndex > 1) ranges.push([greatestIndex, last]);
  }

  return retained;
}

function metersToLatitudeDegrees(meters) {
  return meters / 111_195.080_233_532_9;
}

export function validateCoordinate(position, path = "coordinate") {
  return validateCanonicalPosition(position, path);
}

export function validateLineString(geometry, path = "geometry") {
  return validateCanonicalLineString(geometry, path);
}

export function cloneLineString(geometry) {
  validateLineString(geometry);
  return {
    ...geometry,
    coordinates: geometry.coordinates.map(clonePosition),
  };
}

export function lineStringBounds(geometry) {
  validateLineString(geometry);
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;

  for (const [longitude, latitude] of geometry.coordinates) {
    west = Math.min(west, longitude);
    south = Math.min(south, latitude);
    east = Math.max(east, longitude);
    north = Math.max(north, latitude);
  }
  return [west, south, east, north];
}

export const getBounds = lineStringBounds;
export const calculateBounds = lineStringBounds;

export function lineStringEndpoints(geometry) {
  validateLineString(geometry);
  return {
    start: clonePosition(geometry.coordinates[0]),
    end: clonePosition(geometry.coordinates.at(-1)),
  };
}

export function reverseLineString(geometry) {
  validateLineString(geometry);
  return {
    ...geometry,
    coordinates: geometry.coordinates.map(clonePosition).reverse(),
  };
}

/**
 * Return a deterministic orientation. With no requested start, the
 * lexicographically smaller endpoint is first. When both endpoints are the
 * same distance from the requested start, that canonical rule breaks the tie.
 */
export function orientLineString(geometry, requestedStart) {
  validateLineString(geometry);
  if (requestedStart !== undefined) validateCoordinate(requestedStart, "requestedStart");

  const start = geometry.coordinates[0];
  const end = geometry.coordinates.at(-1);
  let reverse = comparePositions(start, end) > 0;

  if (requestedStart !== undefined) {
    const startDistance = squaredPlanarDistanceToSegment(requestedStart, start, start);
    const endDistance = squaredPlanarDistanceToSegment(requestedStart, end, end);
    if (startDistance < endDistance) reverse = false;
    if (endDistance < startDistance) reverse = true;
  }

  return reverse ? reverseLineString(geometry) : cloneLineString(geometry);
}

/**
 * Simplify a copy for display while preserving every retained coordinate,
 * including optional altitude values. The input routing geometry is never
 * mutated.
 */
export function simplifyLineString(geometry, toleranceMeters) {
  validateLineString(geometry);
  if (!Number.isFinite(toleranceMeters) || toleranceMeters < 0) {
    throw new TypeError("toleranceMeters must be a non-negative finite number");
  }

  const coordinates = geometry.coordinates;
  if (coordinates.length <= 2 || toleranceMeters === 0) return cloneLineString(geometry);

  const toleranceDegrees = metersToLatitudeDegrees(toleranceMeters);
  const retained = simplifyCoordinates(coordinates, toleranceDegrees ** 2);

  return {
    ...geometry,
    coordinates: [...retained]
      .sort((left, right) => left - right)
      .map((index) => clonePosition(coordinates[index])),
  };
}

export const createDisplayGeometry = simplifyLineString;
export const simplifyForDisplay = simplifyLineString;
