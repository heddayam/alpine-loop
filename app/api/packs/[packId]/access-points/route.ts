import { NextResponse } from "next/server";
import fixtureGraph from "@/data/fixtures/graph/tiny.json";
import { bboxSchema } from "@/lib/contracts";

export async function GET(
  request: Request,
  context: { params: Promise<{ packId: string }> },
) {
  const { packId } = await context.params;
  if (packId !== fixtureGraph.packId) {
    return NextResponse.json({ error: "Pack not found" }, { status: 404 });
  }

  const values = new URL(request.url).searchParams.get("bbox")?.split(",").map(Number);
  const parsedBounds = bboxSchema.safeParse(values);
  if (!parsedBounds.success) {
    return NextResponse.json({ error: "A valid bbox query is required" }, { status: 400 });
  }
  const [west, south, east, north] = parsedBounds.data;
  const nodesById = new Map(fixtureGraph.nodes.map((node) => [node.id, node]));
  const accessPoints = fixtureGraph.accessPoints.flatMap((accessPoint) => {
    const node = nodesById.get(accessPoint.nodeId);
    if (!node || node.lon < west || node.lon > east || node.lat < south || node.lat > north) return [];
    return [{
      id: accessPoint.id,
      name: accessPoint.name,
      lon: node.lon,
      lat: node.lat,
      kind: accessPoint.kind,
      accessState: accessPoint.accessState,
      confidence: accessPoint.confidence,
    }];
  });
  return NextResponse.json({ accessPoints });
}
