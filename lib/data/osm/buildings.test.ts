import { describe, expect, it } from "vitest";
import { parseBuildingCentroids } from "./buildings";

const RS = "\u001E";

function record(geometry: unknown): string {
  return `${RS}${JSON.stringify({ type: "Feature", properties: {}, geometry })}\n`;
}

describe("parseBuildingCentroids", () => {
  it("reduces polygons, points, and ways to centroids", () => {
    const centroids = parseBuildingCentroids([
      record({ type: "Polygon", coordinates: [[[0, 0], [0, 2], [2, 2], [2, 0]]] }),
      record({ type: "Point", coordinates: [10, 20] }),
      record({ type: "LineString", coordinates: [[4, 4], [6, 6]] }),
    ].join(""));
    expect(centroids).toEqual([[1, 1], [10, 20], [5, 5]]);
  });

  it("rounds to about a metre so the retained file stays small", () => {
    const [centroid] = parseBuildingCentroids(record({
      type: "Point", coordinates: [-122.023848412345, 36.980123498765],
    }));
    expect(centroid).toEqual([-122.02385, 36.98012]);
  });

  it("skips features osmium emits without usable geometry", () => {
    const centroids = parseBuildingCentroids([
      record(null),
      record({ type: "Polygon", coordinates: [[]] }),
      record({ type: "GeometryCollection", geometries: [] }),
      record({ type: "Point", coordinates: [1, 1] }),
    ].join(""));
    expect(centroids).toEqual([[1, 1]]);
  });

  it("tolerates the trailing separator and blank records", () => {
    expect(parseBuildingCentroids(`${RS}\n${record({ type: "Point", coordinates: [1, 2] })}${RS}\n`))
      .toEqual([[1, 2]]);
  });
});
