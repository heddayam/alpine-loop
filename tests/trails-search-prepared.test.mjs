import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import {
  pointInDriveTimeGeometry,
  pointInPreparedDriveTimeGeometry,
  prepareDriveTimeGeometry,
  searchTrails,
} from "../app/trails/search.ts";

const REGIONAL_ACCESS_POINT_COUNT = 24_029;
const sourceRef = {
  provider: "fixture",
  sourceId: "prepared-geometry",
  retrievedAt: "2026-08-04T00:00:00.000Z",
  sourceUrl: "https://example.test/prepared-geometry",
};

function assertPreparedMatchesNaive(geometry, points) {
  const prepared = prepareDriveTimeGeometry(geometry);
  for (const point of points) {
    assert.equal(
      pointInPreparedDriveTimeGeometry(point, prepared),
      pointInDriveTimeGeometry(point, geometry),
      `prepared result differed at ${JSON.stringify(point)}`,
    );
  }
}

function subdividedRectangle(minimumX, minimumY, maximumX, maximumY, subdivisions) {
  const ring = [];
  for (let index = 0; index <= subdivisions; index += 1) {
    ring.push([minimumX + (maximumX - minimumX) * index / subdivisions, minimumY]);
  }
  for (let index = 1; index <= subdivisions; index += 1) {
    ring.push([maximumX, minimumY + (maximumY - minimumY) * index / subdivisions]);
  }
  ring.push([maximumX, maximumY]);
  for (let index = 1; index <= subdivisions; index += 1) {
    ring.push([maximumX - (maximumX - minimumX) * index / subdivisions, maximumY]);
  }
  for (let index = 1; index <= subdivisions; index += 1) {
    ring.push([minimumX, maximumY - (maximumY - minimumY) * index / subdivisions]);
  }
  ring.push(ring[0]);
  return ring;
}

test("prepared geometry preserves boundaries, holes, bin edges, and repeated vertices", () => {
  const outer = subdividedRectangle(0, 0, 8, 4, 64);
  outer.splice(100, 0, outer[99]);
  const geometry = {
    type: "Polygon",
    coordinates: [
      outer,
      [[2, 1], [6, 1], [6, 3], [6, 3], [2, 3], [2, 1]],
    ],
  };
  const prepared = prepareDriveTimeGeometry(geometry);
  const preparedOuter = prepared.polygons[0].outer;
  const exactBinLatitudes = Array.from(
    { length: preparedOuter.latitudeBins.length - 1 },
    (_, index) => preparedOuter.minimumLatitude +
      (preparedOuter.maximumLatitude - preparedOuter.minimumLatitude) *
      (index + 1) / preparedOuter.latitudeBins.length,
  );
  const points = [
    [0, 2],
    [4, 0],
    [8, 4],
    [4, 2],
    [2, 2],
    [6, 2],
    [1, 1],
    [7, 3],
    [9, 2],
    ...exactBinLatitudes.flatMap((latitude) => [[1, latitude], [4, latitude], [9, latitude]]),
  ];
  assertPreparedMatchesNaive(geometry, points);
  assert.equal(pointInPreparedDriveTimeGeometry([2, 2], prepared), true);
  assert.equal(pointInPreparedDriveTimeGeometry([4, 2], prepared), false);
});

test("prepared geometry preserves planar antimeridian-adjacent and overlapping MultiPolygon behavior", () => {
  const geometry = {
    type: "MultiPolygon",
    coordinates: [
      [[[179, -2], [180, -2], [180, 2], [179, 2], [179, -2]]],
      [[[179.5, -1], [180, -1], [180, 1], [179.5, 1], [179.5, -1]]],
      [[[-180, -2], [-179, -2], [-179, 2], [-180, 2], [-180, -2]]],
    ],
  };
  const points = [
    [180, 0],
    [179.75, 0],
    [179.5, 1],
    [-180, 0],
    [-179.5, 0],
    [-178.5, 0],
    [0, 0],
  ];
  assertPreparedMatchesNaive(geometry, points);
});

test("prepared geometry differentially matches randomized Polygon and MultiPolygon points", () => {
  const geometries = [
    {
      type: "Polygon",
      coordinates: [
        [[-10, -8], [12, -7], [9, 9], [-8, 11], [-10, -8]],
        [[-2, -2], [5, -1], [4, 4], [-3, 3], [-2, -2]],
      ],
    },
    {
      type: "MultiPolygon",
      coordinates: [
        [[[-20, -4], [-11, -6], [-10, 5], [-21, 4], [-20, -4]]],
        [[[2, -12], [14, -10], [13, 1], [3, 2], [2, -12]]],
      ],
    },
  ];
  let state = 0x6d2b79f5;
  const random = () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
  const points = Array.from({ length: 5_000 }, () => [
    -25 + random() * 50,
    -20 + random() * 40,
  ]);
  for (const geometry of geometries) assertPreparedMatchesNaive(geometry, points);
});

function radialRing(vertexCount, alternatingRadius = false) {
  const uniqueVertexCount = vertexCount - 1;
  const ring = Array.from({ length: uniqueVertexCount }, (_, index) => {
    const angle = index / uniqueVertexCount * Math.PI * 2;
    const radius = alternatingRadius && index % 2 === 1 ? 0.82 : 1;
    return [radius * Math.cos(angle), radius * Math.sin(angle)];
  });
  ring.push(ring[0]);
  return ring;
}

test("prepared geometry matches the naive algorithm on an adversarial long ring", () => {
  const geometry = {
    type: "Polygon",
    coordinates: [radialRing(20_001, true)],
  };
  const points = Array.from({ length: 256 }, (_, index) => {
    const angle = index / 256 * Math.PI * 2 + 0.000_031;
    const radius = 0.7 + (index % 5) * 0.075;
    return [radius * Math.cos(angle), radius * Math.sin(angle)];
  });
  assertPreparedMatchesNaive(geometry, points);
});

test("prepared geometry matches naive behavior when most edges span the latitude index", () => {
  const uniqueVertexCount = 8_192;
  const ring = Array.from({ length: uniqueVertexCount }, (_, index) => [
    -1 + index / (uniqueVertexCount - 1) * 2,
    index % 2 === 0 ? -1 : 1,
  ]);
  ring.push(ring[0]);
  const geometry = { type: "Polygon", coordinates: [ring] };
  const prepared = prepareDriveTimeGeometry(geometry);
  assert.ok(prepared.polygons[0].outer.spanningEdgeIndexes.length > 8_000);

  const points = Array.from({ length: 128 }, (_, index) => [
    -1.1 + index / 127 * 2.2,
    -0.97 + (index % 17) / 16 * 1.94,
  ]);
  assertPreparedMatchesNaive(geometry, points);
});

function regionalPerformanceFixture(vertexCount) {
  const accessPoints = Array.from({ length: REGIONAL_ACCESS_POINT_COUNT }, (_, index) => {
    const column = index % 157;
    const row = Math.floor(index / 157);
    const longitude = -1.1 + (column + 0.37) / 157 * 2.2;
    const latitude = -1.1 + (row + 0.61) / 154 * 2.2;
    const id = `access_${index.toString(16).padStart(6, "0")}`;
    return {
      type: "Feature",
      id,
      geometry: { type: "Point", coordinates: [longitude, latitude] },
      properties: {
        id,
        type: "derived",
        confidence: "derived",
        connectedNodeIds: [`node_${index.toString(16).padStart(6, "0")}`],
        sourceRefs: [sourceRef],
      },
    };
  });
  const accessPointIds = accessPoints.map(({ properties }) => properties.id);
  return {
    geometry: { type: "Polygon", coordinates: [radialRing(vertexCount)] },
    catalog: {
      manifest: {
        schemaVersion: 2,
        generatedAt: "2026-08-04T00:00:00.000Z",
        region: { id: "prepared-scale", label: "Prepared scale", bounds: [-2, -2, 2, 2] },
      },
      namedTrails: [{
        id: "named-trail_prepared",
        name: "Prepared Geometry Trail",
        segmentIds: ["segment_aa00"],
        accessPointIds,
        bounds: [-1, -1, 1, 1],
        sourceRefs: [sourceRef],
        dataConfidence: "medium",
      }],
      accessPoints,
      summaries: {
        "named-trail_prepared": {
          hiking: "allowed",
          access: "public",
          status: "open",
          routeClass: "hiking",
        },
      },
      shardPaths: {},
      partitionPrefixLength: 2,
    },
  };
}

for (const vertexCount of [50_001, 200_000]) {
  test(`24,029-point search uses bounded candidates for a ${vertexCount.toLocaleString("en-US")}-vertex contour`, (context) => {
    const { geometry, catalog } = regionalPerformanceFixture(vertexCount);
    const prepareStartedAt = performance.now();
    const prepared = prepareDriveTimeGeometry(geometry);
    const preparationMilliseconds = performance.now() - prepareStartedAt;
    const stats = { candidateEdges: 0, edgeChecks: 0, boundsRejected: 0 };
    const classificationStartedAt = performance.now();
    for (const feature of catalog.accessPoints) {
      pointInPreparedDriveTimeGeometry(feature.geometry.coordinates, prepared, stats);
    }
    const classificationMilliseconds = performance.now() - classificationStartedAt;
    const naiveEdgeChecks = vertexCount * REGIONAL_ACCESS_POINT_COUNT;
    const candidateReduction = naiveEdgeChecks / stats.candidateEdges;

    const searchStartedAt = performance.now();
    const response = searchTrails(catalog, {
      regionId: "prepared-scale",
      driveTimePolygon: geometry,
      limit: 500,
    });
    const searchMilliseconds = performance.now() - searchStartedAt;

    assert.equal(response.count, 1);
    assert.ok(response.trails[0].accessPoints.length <= 2);
    assert.ok(stats.candidateEdges < naiveEdgeChecks / 200, JSON.stringify(stats));
    assert.ok(stats.edgeChecks <= stats.candidateEdges);
    context.diagnostic([
      `${vertexCount.toLocaleString("en-US")} vertices`,
      `${stats.candidateEdges.toLocaleString("en-US")} candidate edges`,
      `${candidateReduction.toFixed(0)}x candidate reduction`,
      `${preparationMilliseconds.toFixed(1)} ms preparation`,
      `${classificationMilliseconds.toFixed(1)} ms classification`,
      `${searchMilliseconds.toFixed(1)} ms end-to-end search`,
    ].join("; "));
  });
}
