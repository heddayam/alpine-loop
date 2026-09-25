import { DatabaseSync } from "node:sqlite";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { PreparedGraphRepository } from "./prepared-repository";
import { SQLiteGraphRepository } from "./sqlite-repository";
import { writeGraphFixture, promoteGraphFixture, GRAPH_FIXTURE_IDENTITY } from "./test-helpers";
import { coordinateIsInsideArea, segmentIntersectsArea, type AreaGeometry } from "./geometry";
import type { GraphEdge, GraphNode, InducedGraph, ReachableGraphQuery } from "./types";
import { ReachableGraphClosedRouteSolver } from "../solver/reachable-graph-closed-route-solver";

const directories: string[] = [];
const repositories: Array<PreparedGraphRepository | SQLiteGraphRepository> = [];
afterEach(async () => {
  for (const repository of repositories.splice(0)) await repository.close();
  for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});
function rectangle(west: number, south: number, east: number, north: number): AreaGeometry {
  return { type: "Polygon", coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]] };
}
const full = rectangle(-0.002, -0.002, 0.002, 0.002);
const sections = [
  rectangle(-0.002, -0.002, 0, 0), rectangle(0, -0.002, 0.002, 0),
  rectangle(-0.002, 0, 0, 0.002), rectangle(0, 0, 0.002, 0.002),
];
function graph(): InducedGraph {
  // A loop through four sections, a seam-aligned edge and a corner start.
  const positions: Array<[string, number, number]> = [
    ["s", 0, 0], ["a", -0.001, -0.001], ["b", 0.001, -0.001],
    ["c", 0.001, 0.001], ["d", -0.001, 0.001], ["e", 0, 0.001],
  ];
  const nodes = new Map<string, GraphNode>(positions.map(([id, lon, lat]) => [id, { id, lon, lat, elevationMeters: 100, flags: [] }]));
  const edges: GraphEdge[] = [];
  for (const [index, [from, to]] of [["s", "a"], ["a", "b"], ["b", "c"], ["c", "d"], ["d", "s"], ["s", "e"]].entries()) {
    for (const [a, b] of [[from, to], [to, from]]) {
      const source = nodes.get(a)!, target = nodes.get(b)!;
      edges.push({
        id: `${a}-${b}`, edgeKey: edges.length + 1, physicalEdgeKey: index + 1,
        fromNodeId: a, toNodeId: b, coordinates: [[source.lon, source.lat], [target.lon, target.lat]],
        lengthMeters: 200, gainMeters: 0, lossMeters: 0, maximumElevationMeters: 100,
        maximumSustainedGradePct: 0, accessState: "public", edgeClass: "trail", trailName: null,
        sourceIds: ["fixture"], flags: [],
      });
    }
  }
  return { nodes, edges, accessPoints: [{
    id: "start", nodeId: "s", name: "Start", kind: "trailhead", accessState: "public",
    confidence: "high", parkingEvidence: null, sourceIds: ["fixture"], nearbyBuildingCount: 0,
  }] };
}
function fixture(mixedIds = false) {
  const directory = mkdtempSync(join(tmpdir(), "prepared-reader-"));
  directories.push(directory);
  const original = join(directory, "original.sqlite");
  const input = graph();
  if (mixedIds) {
    const ids = ["a_1", "a-1", "a:A", "a:a", "a:0", "a.0"];
    let index = 0;
    input.edges = input.edges.map(edge => edge.fromNodeId === "s" ? { ...edge, id: ids[index++]! } : edge);
  }
  writeGraphFixture(original, input);
  const mono = new SQLiteGraphRepository(original, GRAPH_FIXTURE_IDENTITY.id);
  repositories.push(mono);
  const prepared = join(directory, "complete.sqlite");
  copyFileSync(original, prepared);
  promoteGraphFixture(prepared, "release");
  const artifacts = sections.map((geometry, index) => {
    const path = join(directory, `piece-${index}.sqlite`);
    copyFileSync(prepared, path);
    const db = new DatabaseSync(path);
    db.exec("PRAGMA foreign_keys=OFF");
    const remove = db.prepare("DELETE FROM edges WHERE id = ?");
    for (const row of db.prepare("SELECT id,geometry FROM edges").all()) {
      const coordinates = JSON.parse(String(row.geometry)) as Array<[number, number]>;
      if (!coordinates.slice(1).some((coordinate, i) => segmentIntersectsArea(coordinates[i], coordinate, geometry))) remove.run(row.id);
    }
    db.exec("DELETE FROM nodes WHERE id NOT IN (SELECT from_node FROM edges UNION SELECT to_node FROM edges UNION SELECT node_id FROM access_points)");
    for (const row of db.prepare("SELECT a.id, n.lon, n.lat FROM access_points a JOIN nodes n ON n.id=a.node_id").all()) {
      if (!coordinateIsInsideArea([Number(row.lon), Number(row.lat)], geometry)) db.prepare("DELETE FROM access_points WHERE id=?").run(row.id);
    }
    // Fresh subset exports retain global keys but assign unrelated local rowids.
    db.exec("UPDATE nodes SET rowid=rowid+1000000; UPDATE edges SET rowid=rowid+2000000");
    db.close();
    return { path, geometry };
  });
  const open = (selected = artifacts, coverage = full) => {
    const repository = new PreparedGraphRepository({ releaseId: "release", installationId: GRAPH_FIXTURE_IDENTITY.id, artifacts: selected, coverage });
    repositories.push(repository);
    return repository;
  };
  return { directory, prepared, mono, artifacts, open };
}
const query: ReachableGraphQuery = {
  startNodeId: "s", startCoordinates: [0, 0], maximumDistanceMeters: 5_000, maximumDirectedEdges: 100,
  includeUncertainAccess: true, coverage: full,
};
const sortedEdges = (graph: InducedGraph) => [...graph.edges].sort((a, b) => a.id.localeCompare(b.id));

test("pieces match the monolithic graph across seams, corner starts and boundary-aligned edges", async () => {
  const { mono, artifacts, open } = fixture();
  const expected = await mono.getReachableGraph(query);
  for (const order of [artifacts, [...artifacts].reverse(), [...artifacts, artifacts[0]]]) {
    const repository = open(order);
    const actual = await repository.getReachableGraph(query);
    expect(sortedEdges(actual.graph)).toEqual(sortedEdges(expected.graph));
    expect([...actual.graph.nodes].sort()).toEqual([...expected.graph.nodes].sort());
    const candidates = await repository.getAccessPointCandidates({ bbox: [-1, -1, 1, 1], includeUncertainAccess: true });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ knownMinimumStemMeters: 0, inclusiveMinimumStemMeters: 0 });
    const display = [];
    for await (const edge of repository.iterateMapTrails({ bbox: [-1, -1, 1, 1], includeUncertainAccess: true })) display.push(edge);
    expect(display).toHaveLength(6);
    expect(new Set(display.map(edge => edge.physicalEdgeKey)).size).toBe(6);
    const induced = await repository.getInducedGraph({ bbox: [-1, -1, 1, 1], includeUncertainAccess: true });
    expect(sortedEdges(induced)).toEqual(sortedEdges(expected.graph));
    expect(actual.truncated).toBe(false);
  }
});

test("solver exact routes are unchanged; a missing section cannot borrow its cycle", async () => {
  const { mono, artifacts, open } = fixture();
  const solver = new ReachableGraphClosedRouteSolver({ pack: GRAPH_FIXTURE_IDENTITY });
  const request = {
    distanceMiles: { min: 0.6, max: 0.65 }, includeUncertainAccess: true, searchEffort: "quick" as const, limit: 1,
    closedRoute: { maximumRepeatedTrailPct: 100, allowMultiCycle: true },
  };
  const solve = (repository: PreparedGraphRepository | SQLiteGraphRepository, coverage = full) => solver.generate(request, {
    repository, accessFilter: { predicates: [rectangle(-0.00001, -0.00001, 0.00001, 0.00001)], coverage },
    budget: { maximumDirectedEdges: 100, maximumExpandedStates: 20_000, maximumRawCandidates: 2_000, deadlineMs: 10_000 }, now: () => 0,
  });
  const expected = await solve(mono), actual = await solve(open());
  expect(actual).toEqual(expected);
  expect(actual.exact).toHaveLength(1);
  const coverage: AreaGeometry = { type: "MultiPolygon", coordinates: sections.slice(0, 3).map(section => section.type === "Polygon" ? section.coordinates : section.coordinates[0]) };
  const partial = open(artifacts.slice(0, 3), coverage);
  expect((await partial.getAccessPointCandidates({ bbox: [-1, -1, 1, 1], includeUncertainAccess: true }))[0].inclusiveMinimumStemMeters).toBe(0);
  const result = await solve(partial, coverage);
  expect(result.exact).toEqual([]);
  expect(result.nearMisses).toEqual([]);
  expect(result.diagnostics.noCycleAccessPointCount).toBe(0);
});

test("complete geometry rejects edges that cross an uninstalled hole even with both endpoints installed", async () => {
  const { artifacts, open } = fixture();
  const coverage: AreaGeometry = {
    type: "Polygon", coordinates: [
      [[-0.002, -0.002], [0.002, -0.002], [0.002, 0.002], [-0.002, 0.002], [-0.002, -0.002]],
      [[-0.0002, -0.0012], [0.0002, -0.0012], [0.0002, -0.0008], [-0.0002, -0.0008], [-0.0002, -0.0012]],
    ],
  };
  const result = await open(artifacts, coverage).getReachableGraph({ ...query, coverage });
  expect(result.graph.edges.some(edge => edge.id === "a-b" || edge.id === "b-a")).toBe(false);
});

test("retains budgets, stable numeric identities and rejects invalid hints or release metadata", async () => {
  const { mono, artifacts, prepared, open } = fixture();
  const repository = open();
  const bounded = await repository.getReachableGraph({ ...query, maximumDirectedEdges: 3 });
  expect(bounded.truncated).toBe(true);
  expect(bounded.graph.edges).toHaveLength(3);
  expect(bounded.graph.edges).toEqual((await mono.getReachableGraph({ ...query, maximumDirectedEdges: 3 })).graph.edges);
  await repository.close();
  const db = new DatabaseSync(artifacts[0].path);
  db.exec("UPDATE access_points SET known_minimum_stem_m=-1");
  db.close();
  await expect(open().getAccessPointCandidates({ bbox: [-1, -1, 1, 1], includeUncertainAccess: true })).rejects.toThrow("corruption");
  const corrupt = new DatabaseSync(prepared);
  corrupt.exec("UPDATE metadata SET value='wrong' WHERE key='releaseId'");
  corrupt.close();
  await expect(open([{ path: prepared, geometry: full }]).getReachableGraph(query)).rejects.toThrow("identity mismatch");
});

test("missing compact hint columns and unsafe numerical identities are errors", async () => {
  const { artifacts, open } = fixture();
  const db = new DatabaseSync(artifacts[0].path);
  db.exec("ALTER TABLE access_points DROP COLUMN known_minimum_stem_m");
  db.close();
  await expect(open().getReachableGraph(query)).rejects.toThrow("corruption");
  const second = fixture();
  const other = new DatabaseSync(second.artifacts[0].path);
  other.exec("PRAGMA foreign_keys=OFF; UPDATE edges SET physical_edge_key=-1");
  other.close();
  await expect(second.open().getReachableGraph(query)).rejects.toThrow("physical_edge_key");
});

test("bounds concurrent reader lifetime to eight handles and closes all on shutdown", async () => {
  const { directory, prepared, open } = fixture();
  const artifacts = Array.from({ length: 24 }, (_, index) => {
    const path = join(directory, `duplicate-${index}.sqlite`);
    copyFileSync(prepared, path);
    return { path, geometry: full };
  });
  const repository = open(artifacts);
  const generator = repository.iterateMapTrails({ bbox: [-1, -1, 1, 1], includeUncertainAccess: true });
  expect((await generator.next()).done).toBe(false);
  await repository.getAccessPointCandidates({ bbox: [-1, -1, 1, 1], includeUncertainAccess: true });
  expect(repository.connectionStats).toEqual({ open: 8, peak: 8, limit: 8 });
  // Resume after the generator's original handle was evicted.
  let count = 1;
  for await (const edge of generator) { expect(edge.id).toBeTruthy(); count++; }
  expect(count).toBe(6);
  await repository.close();
  expect(repository.connectionStats.open).toBe(0);
  await expect(repository.getReachableGraph(query)).rejects.toThrow("closed");
});

test("null hints prove release-wide absence while missing rows and conflicting duplicates fail closed", async () => {
  const { artifacts, prepared, open } = fixture();
  const db = new DatabaseSync(prepared);
  db.exec("UPDATE access_points SET known_minimum_stem_m=NULL, inclusive_minimum_stem_m=NULL");
  db.close();
  const noCycle = open([{ path: prepared, geometry: full }]);
  const points = await noCycle.getAccessPointCandidates({ bbox: [-1, -1, 1, 1], includeUncertainAccess: true });
  expect(points[0]).toMatchObject({ canReachCycle: false, knownMinimumStemMeters: null, inclusiveMinimumStemMeters: null });
  const mismatch = new DatabaseSync(artifacts[1].path);
  mismatch.exec("UPDATE access_points SET name='conflict'");
  mismatch.close();
  await expect(open().getAccessPointCandidates({ bbox: [-1, -1, 1, 1], includeUncertainAccess: true })).rejects.toThrow("conflicting");
});

test("cancels graph reads and rejects query coordinates that cannot locate the start", async () => {
  const { open } = fixture();
  const repository = open();
  await expect(repository.getReachableGraph({ ...query, signal: AbortSignal.abort(new Error("cancelled")) })).rejects.toThrow("cancelled");
  await expect(repository.getReachableGraph({ ...query, startCoordinates: undefined })).rejects.toThrow("startCoordinates");
  expect((await repository.getReachableGraph({ ...query, startCoordinates: [1, 1] })).graph.edges).toEqual([]);
});

test("excludes starts whose complete departures leave the installed subset", async () => {
  const { artifacts, open } = fixture();
  const repository = open(artifacts, rectangle(-0.0001, -0.0001, 0.0001, 0.0001));
  expect(await repository.getAccessPointCandidates({ bbox: [-1, -1, 1, 1], includeUncertainAccess: true })).toEqual([]);
});

test("budgeted adjacency keeps SQLite BINARY ID order for mixed IDs and reversed artifact order", async () => {
  const { mono, artifacts, open } = fixture(true);
  const bounded = { ...query, maximumDirectedEdges: 2 };
  const expected = await mono.getReachableGraph(bounded);
  expect(expected.truncated).toBe(true);
  for (const order of [artifacts, [...artifacts].reverse()]) {
    const actual = await open(order).getReachableGraph(bounded);
    expect(actual).toEqual(expected);
  }
});

test("reuses fixed SQL statements across reachable reads and closes them with connections", async () => {
  const { prepared, open } = fixture();
  const repository = open([{ path: prepared, geometry: full }]);
  const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
  try {
    const first = await repository.getReachableGraph(query);
    const initial = prepare.mock.calls.length;
    expect(initial).toBeGreaterThan(0);
    expect(await repository.getReachableGraph(query)).toEqual(first);
    expect(prepare.mock.calls).toHaveLength(initial);
    await repository.close();
    await expect(repository.getReachableGraph(query)).rejects.toThrow("closed");
  } finally { prepare.mockRestore(); }
});

test("retains exact query coverage when it differs from installation coverage", async () => {
  const { open } = fixture();
  const repository = open();
  const unrestricted = await repository.getReachableGraph(query);
  const narrow = await repository.getReachableGraph({ ...query, coverage: rectangle(-0.0001, -0.0001, 0.0001, 0.0001) });
  expect(unrestricted.graph.edges.length).toBeGreaterThan(0);
  expect(narrow.graph.edges).toEqual([]);
  expect(await repository.getReachableGraph(query)).toEqual(unrestricted);
});


test("candidate batching falls back from an ineligible first departure and validates its records", async () => {
  const { prepared, open } = fixture();
  const db = new DatabaseSync(prepared);
  db.exec("UPDATE edges SET access_state='private' WHERE id='s-a'");
  db.close();
  const repository = open([{ path: prepared, geometry: full }]);
  const candidates = { bbox: [-1, -1, 1, 1] as const, includeUncertainAccess: true };
  expect(await repository.getAccessPointCandidates(candidates)).toHaveLength(1);
  await repository.close();
  const corrupt = new DatabaseSync(prepared);
  corrupt.exec("PRAGMA foreign_keys=OFF; UPDATE edges SET physical_edge_key=-1 WHERE id='s-a'");
  corrupt.close();
  await expect(open([{ path: prepared, geometry: full }]).getAccessPointCandidates(candidates)).rejects.toThrow("physical_edge_key");
});
