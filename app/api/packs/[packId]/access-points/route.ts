import { NextResponse } from "next/server";
import type { FeatureCollection, LineString } from "geojson";
import { bboxSchema } from "@/lib/contracts";
import { FIXTURE_PACK_TRAIL_NETWORK } from "@/lib/packs/fixture-pack";
import { groupContiguousTrailFeatures } from "@/lib/packs/trail-network";
import { loadRoutePacks } from "@/lib/server/pack-registry";
import { accessPointCanStartClosedRoute } from "@/lib/solver";
import { accessPointIsWildEnough } from "@/lib/data/wilderness";

const MAXIMUM_TRAIL_FEATURES = 75_000;

function canonicalGeometry(coordinates: ReadonlyArray<readonly [number, number]>): string {
  const forward = JSON.stringify(coordinates);
  const reverse = JSON.stringify([...coordinates].reverse());
  return forward < reverse ? forward : reverse;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ packId: string }> },
) {
  const { packId } = await context.params;
  const pack = (await loadRoutePacks()).get(packId);
  if (!pack) return NextResponse.json({ error: "Pack not found" }, { status: 404 });

  const url = new URL(request.url);
  const values = url.searchParams.get("bbox")?.split(",").map(Number);
  const parsedBounds = bboxSchema.safeParse(values);
  if (!parsedBounds.success) {
    return NextResponse.json({ error: "A valid bbox query is required" }, { status: 400 });
  }
  const includeUncertainAccess = url.searchParams.get("includeUncertainAccess") === "true";
  const includeTrails = url.searchParams.get("includeTrails") !== "false";
  const includeAccessPoints = url.searchParams.get("includeAccessPoints") !== "false";
  const controller = new AbortController();
  const repository = await pack.loadRepository(controller.signal);
  try {
    if (!includeTrails) {
      const accessPoints = await repository.getAccessPointCandidates({
        bbox: parsedBounds.data,
        includeUncertainAccess,
        signal: controller.signal,
      });
      return NextResponse.json({
        // Starts with no reachable cycle can never yield a loop, so drawing them
        // only offers the user routes that cannot exist.
        accessPoints: accessPoints.filter(accessPointCanStartClosedRoute).filter(accessPointIsWildEnough).map((point) => ({
          id: point.id,
          name: point.name,
          lon: point.lon,
          lat: point.lat,
          kind: point.kind,
          accessState: point.accessState,
          confidence: point.confidence,
        })),
        trailNetwork: { type: "FeatureCollection", features: [] },
      });
    }
    const [accessPoints, graph] = await Promise.all([
      includeAccessPoints ? repository.getAccessPoints(parsedBounds.data, includeUncertainAccess) : Promise.resolve([]),
      repository.getInducedGraph({
        bbox: parsedBounds.data,
        includeUncertainAccess: true,
        signal: controller.signal,
      }),
    ]);
    const nodes = graph.nodes;
    const seen = new Set<string>();
    const features: FeatureCollection<LineString>["features"] = [];
    if (pack.kind === "installed") {
      for (const edge of graph.edges) {
        const key = canonicalGeometry(edge.coordinates);
        if (seen.has(key)) continue;
        seen.add(key);
        features.push({
          type: "Feature",
          properties: {
            id: edge.id,
            name: edge.trailName,
            distanceMeters: edge.lengthMeters,
            role: "available-trail",
            accessState: edge.accessState,
            sourceIds: edge.sourceIds,
          },
          geometry: { type: "LineString", coordinates: edge.coordinates.map((coordinate) => [...coordinate]) },
        });
        if (features.length > MAXIMUM_TRAIL_FEATURES) {
          return NextResponse.json(
            { error: "Boundary contains too many mapped trail segments; draw a smaller rectangle" },
            { status: 422 },
          );
        }
      }
    }
    return NextResponse.json({
      accessPoints: accessPoints.flatMap((point) => {
        const node = nodes.get(point.nodeId);
        if (!node) {
          return [];
        }
        return [{
          id: point.id,
          name: point.name,
          lon: node.lon,
          lat: node.lat,
          kind: point.kind,
          accessState: point.accessState,
          confidence: point.confidence,
        }];
      }),
      trailNetwork: pack.kind === "fixture"
        ? FIXTURE_PACK_TRAIL_NETWORK
        : groupContiguousTrailFeatures({ type: "FeatureCollection", features }),
    });
  } finally {
    await repository.close();
  }
}
