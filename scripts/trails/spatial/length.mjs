import { validateCoordinate, validateLineString } from "./geometry.mjs";

const WGS84_SEMI_MAJOR_AXIS_METERS = 6_378_137;
const WGS84_FLATTENING = 1 / 298.257_223_563;
const WGS84_SEMI_MINOR_AXIS_METERS =
  WGS84_SEMI_MAJOR_AXIS_METERS * (1 - WGS84_FLATTENING);
const MEAN_EARTH_RADIUS_METERS = 6_371_008.8;

function radians(degrees) {
  return degrees * Math.PI / 180;
}

function longitudeDeltaRadians(left, right) {
  let delta = right - left;
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  return radians(delta);
}

function haversineDistanceMeters(left, right) {
  const latitude1 = radians(left[1]);
  const latitude2 = radians(right[1]);
  const latitudeDelta = latitude2 - latitude1;
  const longitudeDelta = longitudeDeltaRadians(left[0], right[0]);
  const haversine = Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(latitude1) * Math.cos(latitude2) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * MEAN_EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(haversine)));
}

/**
 * WGS84 ellipsoidal distance using Vincenty's inverse formula. The haversine
 * fallback handles the rare antipodal input for which Vincenty does not
 * converge.
 */
export function geodesicDistanceMeters(left, right) {
  validateCoordinate(left, "left");
  validateCoordinate(right, "right");
  if (left[0] === right[0] && left[1] === right[1]) return 0;

  // Canonical endpoint order makes the floating-point result exactly
  // symmetric, which keeps reversed segment builds byte-for-byte stable.
  const [first, second] = left[0] < right[0] ||
    (left[0] === right[0] && left[1] <= right[1])
    ? [left, right]
    : [right, left];

  const reducedLatitude1 = Math.atan(
    (1 - WGS84_FLATTENING) * Math.tan(radians(first[1])),
  );
  const reducedLatitude2 = Math.atan(
    (1 - WGS84_FLATTENING) * Math.tan(radians(second[1])),
  );
  const sinReducedLatitude1 = Math.sin(reducedLatitude1);
  const cosReducedLatitude1 = Math.cos(reducedLatitude1);
  const sinReducedLatitude2 = Math.sin(reducedLatitude2);
  const cosReducedLatitude2 = Math.cos(reducedLatitude2);
  const longitudeDelta = longitudeDeltaRadians(first[0], second[0]);
  let lambda = longitudeDelta;
  let previousLambda;
  let sinSigma;
  let cosSigma;
  let sigma;
  let sinAlpha;
  let cosSquaredAlpha;
  let cosDoubleSigmaMiddle;

  for (let iteration = 0; iteration < 200; iteration += 1) {
    const sinLambda = Math.sin(lambda);
    const cosLambda = Math.cos(lambda);
    sinSigma = Math.sqrt(
      (cosReducedLatitude2 * sinLambda) ** 2 +
      (cosReducedLatitude1 * sinReducedLatitude2 -
        sinReducedLatitude1 * cosReducedLatitude2 * cosLambda) ** 2,
    );
    if (sinSigma === 0) return 0;

    cosSigma = sinReducedLatitude1 * sinReducedLatitude2 +
      cosReducedLatitude1 * cosReducedLatitude2 * cosLambda;
    sigma = Math.atan2(sinSigma, cosSigma);
    sinAlpha = cosReducedLatitude1 * cosReducedLatitude2 * sinLambda / sinSigma;
    cosSquaredAlpha = 1 - sinAlpha ** 2;
    cosDoubleSigmaMiddle = cosSquaredAlpha === 0
      ? 0
      : cosSigma - 2 * sinReducedLatitude1 * sinReducedLatitude2 / cosSquaredAlpha;
    const correction = WGS84_FLATTENING / 16 * cosSquaredAlpha *
      (4 + WGS84_FLATTENING * (4 - 3 * cosSquaredAlpha));
    previousLambda = lambda;
    lambda = longitudeDelta + (1 - correction) * WGS84_FLATTENING * sinAlpha *
      (sigma + correction * sinSigma *
        (cosDoubleSigmaMiddle + correction * cosSigma *
          (-1 + 2 * cosDoubleSigmaMiddle ** 2)));

    if (Math.abs(lambda - previousLambda) <= 1e-12) {
      const squaredU = cosSquaredAlpha *
        (WGS84_SEMI_MAJOR_AXIS_METERS ** 2 - WGS84_SEMI_MINOR_AXIS_METERS ** 2) /
        WGS84_SEMI_MINOR_AXIS_METERS ** 2;
      const coefficientA = 1 + squaredU / 16_384 *
        (4_096 + squaredU * (-768 + squaredU * (320 - 175 * squaredU)));
      const coefficientB = squaredU / 1_024 *
        (256 + squaredU * (-128 + squaredU * (74 - 47 * squaredU)));
      const deltaSigma = coefficientB * sinSigma *
        (cosDoubleSigmaMiddle + coefficientB / 4 *
          (cosSigma * (-1 + 2 * cosDoubleSigmaMiddle ** 2) -
            coefficientB / 6 * cosDoubleSigmaMiddle *
              (-3 + 4 * sinSigma ** 2) *
              (-3 + 4 * cosDoubleSigmaMiddle ** 2)));
      return WGS84_SEMI_MINOR_AXIS_METERS * coefficientA * (sigma - deltaSigma);
    }
  }

  return haversineDistanceMeters(first, second);
}

export const distanceMeters = geodesicDistanceMeters;
export const calculateDistanceMeters = geodesicDistanceMeters;

export function geodesicLineLengthMeters(geometry) {
  validateLineString(geometry);
  let total = 0;
  for (let index = 1; index < geometry.coordinates.length; index += 1) {
    total += geodesicDistanceMeters(
      geometry.coordinates[index - 1],
      geometry.coordinates[index],
    );
  }
  return total;
}

export const lineLengthMeters = geodesicLineLengthMeters;
export const calculateLineLengthMeters = geodesicLineLengthMeters;
