import { DatabaseSync } from "node:sqlite";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { ACCESS_ENTRY_POLICY_VERSION } from "@/lib/contracts/access-policy";
import { PreparedGraphRepository, type PreparedGraphDescriptor } from "./prepared-repository";
import { SQLiteGraphRepository } from "./sqlite-repository";
import { writeGraphFixture, promoteGraphFixture, GRAPH_FIXTURE_IDENTITY } from "./test-helpers";
import { coordinateIsInsideArea, segmentIntersectsArea, type AreaGeometry } from "./geometry";
import type { GraphEdge, GraphNode, InducedGraph, ReachableGraphQuery } from "./types";
import { ReachableGraphClosedRouteSolver } from "../solver/reachable-graph-closed-route-solver";
import * as records from "./sqlite-records";
import { listEligibleAccessPointCandidates } from "../solver/eligible-access-points";

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
    return { path, geometry, accessPolicyVersion: ACCESS_ENTRY_POLICY_VERSION };
  });
  const open = (selected: PreparedGraphDescriptor["artifacts"] = artifacts, coverage = full) => {
    const repository = new PreparedGraphRepository({ releaseId: "release", installationId: GRAPH_FIXTURE_IDENTITY.id, artifacts: selected.map(artifact => ({ ...artifact, accessPolicyVersion: ACCESS_ENTRY_POLICY_VERSION })), coverage });
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
const knownFamily = `entrance-family:${"1".repeat(64)}`;
const inclusiveFamily = `entrance-family:${"2".repeat(64)}`;

function addEntranceFamilies(path: string, rows: Array<["known" | "inclusive", string, string]>): void {
  const database = new DatabaseSync(path);
  try {
    database.exec(`CREATE TABLE access_entrance_families (
      profile TEXT NOT NULL, access_point_id TEXT NOT NULL, family_id TEXT NOT NULL,
      junction_node_id TEXT NOT NULL, approach_distance_m REAL NOT NULL,
      PRIMARY KEY (profile, access_point_id)
    )`);
    const insert = database.prepare("INSERT INTO access_entrance_families VALUES (?, ?, ?, 's', 75)");
    for (const row of rows) insert.run(...row);
  } finally { database.close(); }
}

test("optional entrance families preserve old packs and all candidate identities and filters", async () => {
  const { prepared, open } = fixture();
  const candidatesQuery = { bbox: [-1, -1, 1, 1] as const, includeUncertainAccess: true };
  const legacy = open([{ path: prepared, geometry: full }]);
  const [legacyPoint] = await legacy.getAccessPointCandidates(candidatesQuery);
  expect(legacyPoint).not.toHaveProperty("knownEntranceFamilyId");
  expect(legacyPoint).not.toHaveProperty("inclusiveEntranceFamilyId");
  await legacy.close();

  const database = new DatabaseSync(prepared);
  const columns = database.prepare("PRAGMA table_info(access_points)").all().map(row => String(row.name));
  for (const [id, nodeId] of [["access-a", "a"], ["uncertain", "e"]]) {
    database.prepare(`INSERT INTO access_points SELECT ?, ?, ${columns.slice(2).join(",")} FROM access_points WHERE id='start'`).run(id, nodeId);
  }
  database.exec("UPDATE access_points SET access_state='unknown' WHERE id='uncertain'");
  database.close();
  addEntranceFamilies(prepared, [["known", "start", knownFamily], ["known", "access-a", knownFamily],
    ["inclusive", "start", inclusiveFamily], ["inclusive", "access-a", inclusiveFamily], ["inclusive", "uncertain", inclusiveFamily]]);
  const repository = open([{ path: prepared, geometry: full }]);
  const inclusive = await repository.getAccessPointCandidates(candidatesQuery);
  expect(inclusive.map(point => point.id)).toEqual(["access-a", "start", "uncertain"]);
  expect(inclusive.find(point => point.id === "start")).toEqual({ ...legacyPoint, knownEntranceFamilyId: knownFamily, inclusiveEntranceFamilyId: inclusiveFamily });
  expect(inclusive.find(point => point.id === "access-a")).toMatchObject({ nodeId: "a", lon: -0.001, lat: -0.001 });
  expect(inclusive.find(point => point.id === "uncertain")).not.toHaveProperty("knownEntranceFamilyId");
  const known = await repository.getAccessPointCandidates({ ...candidatesQuery, includeUncertainAccess: false });
  expect(known.map(point => point.id)).toEqual(["access-a", "start"]);
  expect(known.every(point => point.knownEntranceFamilyId === knownFamily && point.inclusiveEntranceFamilyId === inclusiveFamily)).toBe(true);
  expect((await repository.getAccessPointCandidates({ ...candidatesQuery, bbox: [-0.00001, -0.00001, 0.00001, 0.00001] })).map(point => point.id)).toEqual(["start"]);
  expect((await repository.getAccessPointCandidates({ ...candidatesQuery, accessPointId: "access-a" })).map(point => point.id)).toEqual(["access-a"]);
});

test.each(["", "entrance-family:bad", `entrance-family:${"A".repeat(64)}`])("rejects malformed entrance family metadata %j", async family => {
  const { prepared, open } = fixture();
  addEntranceFamilies(prepared, [["inclusive", "start", family]]);
  await expect(open([{ path: prepared, geometry: full }]).getAccessPointCandidates({ bbox: [-1, -1, 1, 1], includeUncertainAccess: false })).rejects.toThrow("invalid inclusive_entrance_family_id");
});

test("pins immutable network identity independently of an expanded release catalog", async () => {
  const { prepared, mono } = fixture();
  const repository = new PreparedGraphRepository({
    releaseId: "expanded-catalog", installationId: "installed-networks",
    artifacts: [{ path: prepared, geometry: full, accessPolicyVersion: ACCESS_ENTRY_POLICY_VERSION, graphId: "release" }], coverage: full,
  });
  repositories.push(repository);
  const expected = await mono.getReachableGraph(query);
  expect(sortedEdges((await repository.getReachableGraph(query)).graph)).toEqual(sortedEdges(expected.graph));
  const wrong = new PreparedGraphRepository({
    releaseId: "expanded-catalog", installationId: "installed-networks",
    artifacts: [{ path: prepared, geometry: full, accessPolicyVersion: ACCESS_ENTRY_POLICY_VERSION, graphId: "wrong-network-version" }], coverage: full,
  });
  repositories.push(wrong);
  await expect(wrong.getReachableGraph(query)).rejects.toThrow("identity mismatch");
});

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
    distanceMiles: { min: 0.6, max: 0.65 }, includeUncertainAccess: true, limit: 1,
    closedRoute: { maximumRepeatedTrailPct: 100 },
  };
  const solve = (repository: PreparedGraphRepository | SQLiteGraphRepository, coverage = full) => solver.generate(request, {
    repository, accessFilter: { predicates: [rectangle(-0.00001, -0.00001, 0.00001, 0.00001)], coverage },
    budget: { maximumDirectedEdges: 100, maximumExpandedStates: 20_000, maximumRetainedCycles: 2_000, deadlineMs: 10_000 }, now: () => 0,
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
  addEntranceFamilies(prepared, [["known", "start", knownFamily], ["inclusive", "start", inclusiveFamily]]);
  const artifacts = Array.from({ length: 24 }, (_, index) => {
    const path = join(directory, `duplicate-${index}.sqlite`);
    copyFileSync(prepared, path);
    return { path, geometry: full };
  });
  const repository = open(artifacts);
  const generator = repository.iterateMapTrails({ bbox: [-1, -1, 1, 1], includeUncertainAccess: true });
  expect((await generator.next()).done).toBe(false);
  expect((await repository.getAccessPointCandidates({ bbox: [-1, -1, 1, 1], includeUncertainAccess: true }))[0])
    .toMatchObject({ knownEntranceFamilyId: knownFamily, inclusiveEntranceFamilyId: inclusiveFamily });
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

test("warm reads reuse decoding without reusing access, distance, or edge-budget decisions", async () => {
  const { prepared, open } = fixture();
  const database = new DatabaseSync(prepared);
  database.exec("UPDATE edges SET access_state='unknown' WHERE id IN ('s-e','e-s')");
  database.close();
  const artifact = [{ path: prepared, geometry: full }];
  const repository = open(artifact);
  const parse = vi.spyOn(records, "parseEdge");
  try {
    const inclusive = await repository.getReachableGraph(query);
    const initial = parse.mock.calls.length;
    expect(initial).toBe(12);
    expect(await repository.getReachableGraph(query)).toEqual(inclusive);
    expect(parse.mock.calls).toHaveLength(initial);
    parse.mockClear();
    for (const options of [{ includeUncertainAccess: false }, { maximumDistanceMeters: 200 }, { maximumDirectedEdges: 2 }]) {
      const changed = { ...query, ...options };
      const warm = await repository.getReachableGraph(changed);
      expect(parse.mock.calls).toHaveLength(0);
      expect(warm).toEqual(await open(artifact).getReachableGraph(changed));
      parse.mockClear();
      // Every subsequent warm call must decode no rows, regardless of filters.
      expect(await repository.getReachableGraph(changed)).toEqual(warm);
      expect(parse.mock.calls).toHaveLength(0);
    }
  } finally { parse.mockRestore(); }
});

test("returned graph and map geometry, profiles, and metadata cannot poison cached edges", async () => {
  const { prepared, open } = fixture();
  const database = new DatabaseSync(prepared);
  database.exec("UPDATE edges SET elevation_profile='[[0,100],[200,100]]'");
  database.close();
  const repository = open([{ path: prepared, geometry: full }]);
  const first = await repository.getReachableGraph(query);
  const expected = structuredClone(first);
  const edge = first.graph.edges[0];
  edge.id = "modified";
  edge.coordinates[0] = [100, 100];
  edge.elevationProfile![0].elevationMeters = 999;
  edge.sourceIds.push("modified");
  edge.flags.push("modified");
  first.graph.nodes.get("s")!.lon = 100;
  expect(await repository.getReachableGraph(query)).toEqual(expected);
  const map = repository.iterateMapTrails({ bbox: [-1, -1, 1, 1], includeUncertainAccess: true });
  const displayed = (await map.next()).value!;
  displayed.coordinates[0] = [100, 100];
  displayed.elevationProfile![0].elevationMeters = 999;
  await map.return(undefined);
  expect(await repository.getReachableGraph(query)).toEqual(expected);
});

test("cached positive and negative containment remain specific to exact query geometry", async () => {
  const { prepared, open } = fixture();
  const repository = open([{ path: prepared, geometry: full }]);
  const hole: AreaGeometry = { type: "Polygon", coordinates: [
    full.type === "Polygon" ? full.coordinates[0] : [],
    [[-0.0002, -0.0012], [0.0002, -0.0012], [0.0002, -0.0008], [-0.0002, -0.0008], [-0.0002, -0.0012]],
  ] };
  const baseline = await repository.getReachableGraph(query);
  const cut = { ...query, coverage: hole };
  const expected = await open([{ path: prepared, geometry: full }]).getReachableGraph(cut);
  expect(expected.graph.edges.some(edge => edge.id === "a-b" || edge.id === "b-a")).toBe(false);
  expect(await repository.getReachableGraph(cut)).toEqual(expected);
  expect(await repository.getReachableGraph(cut)).toEqual(expected);
  expect(await repository.getReachableGraph(query)).toEqual(baseline);
  const [narrow, complete, repeated] = await Promise.all([
    repository.getReachableGraph({ ...query, coverage: rectangle(-0.0001, -0.0001, 0.0001, 0.0001) }),
    repository.getReachableGraph(query), repository.getReachableGraph(cut),
  ]);
  expect(narrow.graph.edges).toEqual([]);
  expect(complete).toEqual(baseline);
  expect(repeated).toEqual(expected);
});

test("closing a repository also prevents a paused map iterator from repopulating its cache", async () => {
  const { open } = fixture();
  const repository = open();
  const map = repository.iterateMapTrails({ bbox: [-1, -1, 1, 1], includeUncertainAccess: true });
  expect((await map.next()).done).toBe(false);
  await repository.close();
  await expect(map.next()).rejects.toThrow("closed");
});

test("different query boundaries keep their own snapshots across asynchronous traversal yields", async () => {
  const directory = mkdtempSync(join(tmpdir(), "prepared-interleaved-reader-"));
  directories.push(directory);
  const path = join(directory, "graph.sqlite");
  const nodes = new Map<string, GraphNode>(Array.from({ length: 256 }, (_, i) => [`n${i}`, {
    id: `n${i}`, lon: 0.001 * Math.cos(i * Math.PI / 128), lat: 0.001 * Math.sin(i * Math.PI / 128),
    elevationMeters: 100, flags: [],
  }]));
  const template = graph().edges[0];
  const edges = [...nodes.values()].map((node, i): GraphEdge => {
    const to = nodes.get(`n${(i + 1) % nodes.size}`)!;
    return { ...template, id: `edge-${i}`, edgeKey: i + 1, physicalEdgeKey: i + 1,
      fromNodeId: node.id, toNodeId: to.id, coordinates: [[node.lon, node.lat], [to.lon, to.lat]], lengthMeters: 1 };
  });
  writeGraphFixture(path, { nodes, edges, accessPoints: [{ ...graph().accessPoints[0], nodeId: "n0" }] });
  promoteGraphFixture(path, "release");
  const open = () => {
    const repository = new PreparedGraphRepository({ releaseId: "release", installationId: "interleaved", coverage: full,
      artifacts: [{ path, geometry: full, startGeometry: full, accessPolicyVersion: ACCESS_ENTRY_POLICY_VERSION }] });
    repositories.push(repository);
    return repository;
  };
  const clipped = (south: number): AreaGeometry => ({ type: "Polygon", coordinates: [
    full.type === "Polygon" ? full.coordinates[0] : [],
    [[-0.0001, south], [0.0001, south], [0.0001, south + 0.0004], [-0.0001, south + 0.0004], [-0.0001, south]],
  ] });
  const queries = [clipped(-0.0012), clipped(0.0008), rectangle(-0.002, -0.002, 0.002, 0.0015)]
    .map(coverage => ({ ...query, coverage, startNodeId: "n0", startCoordinates: [0.001, 0] as const, maximumDirectedEdges: 1_000 }));
  const expected = [];
  for (const request of queries) expected.push(await open().getReachableGraph(request));
  expect(expected[0].graph.nodes.size).toBeGreaterThan(128);
  const repository = open();
  expect(await Promise.all(queries.map(request => repository.getReachableGraph(request)))).toEqual(expected);
  expect(await Promise.all([...queries].reverse().map(request => repository.getReachableGraph(request)))).toEqual([...expected].reverse());
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


test("bounded adjacency pages continue past a full batch of ineligible edges", async () => {
  const { prepared, open } = fixture();
  const database = new DatabaseSync(prepared);
  database.exec("UPDATE edges SET access_state='private'");
  const columns = database.prepare("PRAGMA table_info(edges)").all().map(row => String(row.name));
  const values = columns.map(column => column === "id" || column === "edge_key" ? "?" : column).join(",");
  const insert = database.prepare(`INSERT INTO edges (${columns.join(",")}) SELECT ${values} FROM edges WHERE id='s-a'`);
  for (let index = 0; index < 300; index++) insert.run(`x${String(index).padStart(3, "0")}`, index + 100);
  database.exec("UPDATE edges SET access_state='public' WHERE id='x299'");
  database.close();
  const result = await open([{ path: prepared, geometry: full }]).getReachableGraph(query);
  expect(result.truncated).toBe(false);
  expect(result.graph.edges.map(edge => edge.id)).toEqual(["x299"]);
});


test("authoritative local entrance rows retain buffered loops regardless of display start geometry", async () => {
  const { prepared } = fixture();
  const db = new DatabaseSync(prepared);
  const columns = db.prepare("PRAGMA table_info(access_points)").all().map(row => String(row.name));
  db.exec(`INSERT INTO access_points SELECT 'buffer-start','a',${columns.slice(2).join(',')} FROM access_points WHERE id='start'`);
  db.close();
  const core = rectangle(-0.0001, -0.0001, 0.0001, 0.0001);
  const repository = new PreparedGraphRepository({ releaseId: "release", installationId: "local", coverage: full,
    artifacts: [{ path: prepared, geometry: full, accessPolicyVersion: ACCESS_ENTRY_POLICY_VERSION, startGeometry: core }] });
  repositories.push(repository);
  const candidates = await repository.getAccessPointCandidates({ bbox: [-1, -1, 1, 1], includeUncertainAccess: true });
  expect(candidates.map(point => point.id)).toEqual(["buffer-start", "start"]);
  expect((await repository.getReachableGraph({ ...query, startNodeId: "a", startCoordinates: [-0.001, -0.001] })).graph.edges.length).toBeGreaterThan(0);
  const solver = new ReachableGraphClosedRouteSolver({ pack: { ...GRAPH_FIXTURE_IDENTITY, id: "local" } });
  const result = await solver.generate({ distanceMiles: { min: 0.6, max: 0.65 }, includeUncertainAccess: true, limit: 1,
    closedRoute: { maximumRepeatedTrailPct: 100 } }, {
    repository, accessFilter: { predicates: [core], coverage: full },
    budget: { maximumDirectedEdges: 100, maximumExpandedStates: 20_000, maximumRetainedCycles: 2_000, deadlineMs: 10_000 }, now: () => 0,
  });
  expect(result.exact).toHaveLength(1);
  expect(result.exact[0].geometry.coordinates.some(coordinate => !coordinateIsInsideArea(coordinate as [number, number], core))).toBe(true);
  const trails = [];
  for await (const edge of repository.iterateMapTrails({ bbox: [-0.002, -0.002, 0.002, -0.0005], includeUncertainAccess: true })) trails.push(edge);
  expect(trails.length).toBeGreaterThan(0);
});

test("overlapping local graphs deterministically own starts without mixing topology or profile hints", async () => {
  const { directory, prepared } = fixture();
  const second = join(directory, "z-second.sqlite");
  copyFileSync(prepared, second);
  const firstDb = new DatabaseSync(prepared);
  firstDb.exec("DELETE FROM edges WHERE id IN ('s-e','e-s')"); firstDb.close();
  // Local portal anchoring and hints may differ, even for the same source ID.
  const secondDb = new DatabaseSync(second);
  secondDb.exec("UPDATE nodes SET elevation_m=200; UPDATE edges SET length_m=400; UPDATE access_points SET node_id='a',known_minimum_stem_m=500,inclusive_minimum_stem_m=500"); secondDb.close();
  const core = rectangle(-0.0001, -0.0001, 0.0001, 0.0001);
  const repository = new PreparedGraphRepository({ releaseId: "release", installationId: "local", coverage: full,
    artifacts: [{ path: second, geometry: full, accessPolicyVersion: ACCESS_ENTRY_POLICY_VERSION, startGeometry: full }, { path: prepared, geometry: full, accessPolicyVersion: ACCESS_ENTRY_POLICY_VERSION, startGeometry: core }] });
  repositories.push(repository);
  expect((await repository.getAccessPointCandidates({ bbox: [-1, -1, 1, 1], includeUncertainAccess: true }))[0].inclusiveMinimumStemMeters).toBe(0);
  const first = (await repository.getReachableGraph(query)).graph;
  expect(first.nodes.get("s")!.elevationMeters).toBe(100);
  expect(first.edges.every(edge => edge.lengthMeters === 200)).toBe(true);
  expect(first.edges.some(edge => edge.id === "s-e")).toBe(false);
  const other = (await repository.getReachableGraph({ ...query, startNodeId: "a", startCoordinates: [-0.001, -0.001] })).graph;
  expect(other.nodes.get("s")!.elevationMeters).toBe(200);
  expect(other.edges.every(edge => edge.lengthMeters === 400)).toBe(true);
  await expect(repository.getInducedGraph({ bbox: [-1, -1, 1, 1], includeUncertainAccess: true })).rejects.toThrow("require a starting point");
});


test("named region ownership survives artifact filename changes and catalog ordering", async () => {
  const { directory, prepared } = fixture();
  const neighbor = join(directory, "a-neighbor.sqlite"), updated = join(directory, "z-updated.sqlite");
  copyFileSync(prepared, neighbor); copyFileSync(prepared, updated);
  const db = new DatabaseSync(neighbor);
  db.exec("UPDATE nodes SET elevation_m=200; UPDATE edges SET length_m=400; UPDATE access_points SET known_minimum_stem_m=500,inclusive_minimum_stem_m=500");
  db.close();
  const core = rectangle(-0.0001, -0.0001, 0.0001, 0.0001);
  for (const ownerPath of [prepared, updated]) {
    for (const reverse of [false, true]) {
      const artifacts = [{path:neighbor,accessPolicyVersion:ACCESS_ENTRY_POLICY_VERSION,regionId:"pasayten",geometry:full,startGeometry:core}, {path:ownerPath,accessPolicyVersion:ACCESS_ENTRY_POLICY_VERSION,regionId:"glacier-peak",geometry:full,startGeometry:core}];
      const repository = new PreparedGraphRepository({releaseId:"release",installationId:"local",coverage:full,artifacts:reverse ? artifacts.reverse() : artifacts});
      repositories.push(repository);
      expect((await repository.getAccessPointCandidates({bbox:[-1,-1,1,1],includeUncertainAccess:true}))[0].inclusiveMinimumStemMeters).toBe(0);
      const result = (await repository.getReachableGraph(query)).graph;
      expect(result.nodes.get("s")!.elevationMeters).toBe(100);
      expect(result.edges.every(edge => edge.lengthMeters === 200)).toBe(true);
    }
  }
});

function openLocalArtifacts(artifacts: PreparedGraphDescriptor["artifacts"]): PreparedGraphRepository {
  const repository = new PreparedGraphRepository({ releaseId: "release", installationId: "local", coverage: full,
    artifacts: artifacts.map(artifact => ({ ...artifact, accessPolicyVersion: ACCESS_ENTRY_POLICY_VERSION, startGeometry: full })) });
  repositories.push(repository);
  return repository;
}

test("an ordinary node in an earlier graph cannot shadow an admitted entrance", async () => {
  const { directory, prepared } = fixture();
  const admitted = join(directory, "admitted.sqlite");
  copyFileSync(prepared, admitted);
  const ordinary = new DatabaseSync(prepared);
  ordinary.exec("DELETE FROM access_points"); ordinary.close();
  const actual = new DatabaseSync(admitted);
  actual.exec("UPDATE nodes SET elevation_m=200; UPDATE edges SET length_m=400"); actual.close();
  for (const reverse of [false, true]) {
    const artifacts = [{ path: prepared, regionId: "a-node-only", geometry: full }, { path: admitted, regionId: "b-admitted", geometry: full }];
    const repository = openLocalArtifacts(reverse ? artifacts.reverse() : artifacts);
    const points = await repository.getAccessPointCandidates({ bbox: [-1,-1,1,1], includeUncertainAccess: true });
    expect(points).toHaveLength(1);
    expect(points[0].regionIds).toEqual(["b-admitted"]);
    const result = (await repository.getReachableGraph(query)).graph;
    expect(result.nodes.get("s")?.elevationMeters).toBe(200);
    expect(result.edges.every(edge => edge.lengthMeters === 400)).toBe(true);
  }
});

test("inclusive-only A cannot shadow known B; membership is a union independent of the pinned profile owner", async () => {
  const { directory, prepared } = fixture();
  const known = join(directory, "known.sqlite");
  copyFileSync(prepared, known);
  const uncertain = new DatabaseSync(prepared);
  uncertain.exec("UPDATE access_points SET access_state='unknown',known_minimum_stem_m=NULL,inclusive_minimum_stem_m=75"); uncertain.close();
  const certain = new DatabaseSync(known);
  certain.exec("UPDATE nodes SET elevation_m=200; UPDATE edges SET length_m=400"); certain.close();
  const artifacts = [{ path: known, regionId: "b-known", geometry: full }, { path: prepared, regionId: "a-uncertain", geometry: full }];
  for (const reverse of [false, true]) {
    const repository = openLocalArtifacts(reverse ? [...artifacts].reverse() : artifacts);
    const inclusive = await repository.getAccessPointCandidates({ bbox: [-1,-1,1,1], includeUncertainAccess: true });
    expect(inclusive[0]).toMatchObject({ accessState: "unknown", inclusiveMinimumStemMeters: 75, knownMinimumStemMeters: null, regionIds: ["a-uncertain", "b-known"] });
    const knownOnly = await repository.getAccessPointCandidates({ bbox: [-1,-1,1,1], includeUncertainAccess: false });
    expect(knownOnly[0]).toMatchObject({ accessState: "public", inclusiveMinimumStemMeters: 0, knownMinimumStemMeters: 0, regionIds: ["a-uncertain", "b-known"] });
    expect((await repository.getReachableGraph(query)).graph.nodes.get("s")?.elevationMeters).toBe(100);
    expect((await repository.getReachableGraph({ ...query, includeUncertainAccess: false })).graph.nodes.get("s")?.elevationMeters).toBe(200);
    const result = await listEligibleAccessPointCandidates({ repository, includeUncertainAccess: false,
      accessFilter: { coverage: full, predicates: [rectangle(0.0015,0.0015,0.002,0.002)], namedRegionPredicateIndex: 0, namedRegionIds: ["a-uncertain"] } });
    expect(result.eligible.map(point => point.id)).toEqual(["start"]);
    expect(result.eligible[0].knownMinimumStemMeters).toBe(0);
  }
});

test("owner ordering uses graph identity before filenames and cycle feasibility never substitutes a neighbor", async () => {
  const { directory, prepared } = fixture();
  const later = join(directory, "a-later.sqlite"), earlier = join(directory, "z-earlier.sqlite");
  copyFileSync(prepared, later); copyFileSync(prepared, earlier);
  const db = new DatabaseSync(earlier);
  db.exec("UPDATE metadata SET value='a-graph' WHERE key='releaseId'; UPDATE access_points SET known_minimum_stem_m=NULL,inclusive_minimum_stem_m=NULL"); db.close();
  const repository = openLocalArtifacts([{ path: later, regionId: "same", graphId: "release", geometry: full },
    { path: earlier, regionId: "same", graphId: "a-graph", geometry: full }]);
  const result = await listEligibleAccessPointCandidates({ repository, includeUncertainAccess: true,
    accessFilter: { coverage: full, predicates: [], namedRegionIds: ["same"] } });
  expect(result.matchedFilters).toHaveLength(1);
  expect(result.matchedFilters[0].inclusiveMinimumStemMeters).toBeNull();
  expect(result.eligible).toEqual([]);
  expect(result.noCycleExcluded).toBe(1);
});

test("a public entrance with only an unknown loop is excluded only in the known profile", async () => {
  const { prepared } = fixture();
  const db = new DatabaseSync(prepared);
  db.exec("UPDATE edges SET access_state='unknown' WHERE id IN ('a-b','b-a'); UPDATE access_points SET known_minimum_stem_m=NULL"); db.close();
  const repository = openLocalArtifacts([{ path: prepared, regionId: "selected", geometry: full }]);
  const options = { repository, accessFilter: { coverage: full, predicates: [], namedRegionIds: ["selected"] } };
  const known = await listEligibleAccessPointCandidates({ ...options, includeUncertainAccess: false });
  expect(known.matchedFilters[0]).toMatchObject({ accessState: "public", canReachCycle: false, knownMinimumStemMeters: null });
  expect(known.eligible).toEqual([]);
  expect(known.noCycleExcluded).toBe(1);
  expect((await listEligibleAccessPointCandidates({ ...options, includeUncertainAccess: true })).eligible).toHaveLength(1);
  expect((await repository.getReachableGraph({ ...query, includeUncertainAccess: false })).graph.edges.some(edge => edge.accessState === "unknown")).toBe(false);
});

test("new starts require matching declared and database policy while old trails remain readable", async () => {
  const { prepared } = fixture();
  const old = new PreparedGraphRepository({ releaseId: "release", installationId: "old", coverage: full,
    artifacts: [{ path: prepared, geometry: full, startGeometry: full, regionId: "old" }] });
  repositories.push(old);
  expect(await old.getAccessPointCandidates({ bbox: [-1,-1,1,1], includeUncertainAccess: true })).toEqual([]);
  const trails = [];
  for await (const edge of old.iterateMapTrails({ bbox: [-1,-1,1,1], includeUncertainAccess: true })) trails.push(edge);
  expect(trails).toHaveLength(6);
  await old.close();
  const db = new DatabaseSync(prepared);
  db.exec("DELETE FROM metadata WHERE key='access_policy_version'"); db.close();
  await expect(openLocalArtifacts([{ path: prepared, regionId: "new", geometry: full }]).getAccessPointCandidates({ bbox: [-1,-1,1,1], includeUncertainAccess: true })).rejects.toThrow("access policy identity mismatch");
});

test("distinct new graph identities without local descriptors fail closed while contextual trails remain readable", async () => {
  const { directory, prepared } = fixture();
  const different = join(directory,"different.sqlite"); copyFileSync(prepared,different);
  const db = new DatabaseSync(different);
  db.exec("UPDATE metadata SET value='different' WHERE key='releaseId'"); db.close();
  const repository = new PreparedGraphRepository({ releaseId:"release",installationId:"distinct",coverage:full,
    artifacts:[{path:prepared,geometry:full,graphId:"release",accessPolicyVersion:ACCESS_ENTRY_POLICY_VERSION},
      {path:different,geometry:full,graphId:"different",accessPolicyVersion:ACCESS_ENTRY_POLICY_VERSION}] });
  repositories.push(repository);
  await expect(repository.getAccessPointCandidates({bbox:[-1,-1,1,1],includeUncertainAccess:true})).rejects.toThrow("distinct graph identities cannot be joined");
  await expect(repository.getReachableGraph(query)).rejects.toThrow("distinct graph identities cannot be joined");
  const trails=[];
  for await(const edge of repository.iterateMapTrails({bbox:[-1,-1,1,1],includeUncertainAccess:true})) trails.push(edge);
  expect(trails).toHaveLength(6);
});

test("many-start ownership uses bounded batches without deep node reads and reuses its small admission index", async () => {
  const directory = mkdtempSync(join(tmpdir(), "prepared-many-starts-")); directories.push(directory);
  const path = join(directory, "many.sqlite"), count = 1_200;
  const nodes = new Map<string,GraphNode>(Array.from({ length: count }, (_, i) => [`n${i}`, {
    id: `n${i}`, lon: 0.001*Math.cos(i*2*Math.PI/count), lat: 0.001*Math.sin(i*2*Math.PI/count), elevationMeters: 100, flags: [],
  }]));
  const template = graph().edges[0], entry = graph().accessPoints[0];
  const edges = [...nodes.values()].map((from, i):GraphEdge => {
    const to = nodes.get(`n${(i+1)%count}`)!;
    return { ...template, id: `edge-${i}`, edgeKey: i+1, physicalEdgeKey: i+1, fromNodeId: from.id, toNodeId: to.id,
      coordinates: [[from.lon,from.lat],[to.lon,to.lat]], lengthMeters: 1 };
  });
  writeGraphFixture(path, { nodes, edges, accessPoints: [...nodes.values()].map(node => ({ ...entry, id: `start-${node.id}`, nodeId: node.id })) });
  promoteGraphFixture(path,"release");
  const artifacts = Array.from({ length: 4 }, (_, i) => {
    const copy = join(directory,`area-${i}.sqlite`); copyFileSync(path,copy);
    return { path:copy,regionId:`region-${i}`,geometry:full };
  });
  const repository = openLocalArtifacts([...artifacts].reverse());
  const nativeCalls: string[] = [], originalPrepare = DatabaseSync.prototype.prepare;
  let indexPayloadBytes = 0;
  const prepare = vi.spyOn(DatabaseSync.prototype,"prepare").mockImplementation(function(this:DatabaseSync, sql:string) {
    const statement = originalPrepare.call(this,sql), originalAll = statement.all;
    statement.all = (...parameters:unknown[]) => {
      nativeCalls.push(sql);
      const rows = Reflect.apply(originalAll,statement,parameters) as ReturnType<typeof statement.all>;
      if (sql.includes("SELECT a.id, a.node_id, a.access_state")) indexPayloadBytes += Buffer.byteLength(JSON.stringify(rows));
      return rows;
    };
    return statement;
  });
  const parseNode = vi.spyOn(records,"parseNode");
  try {
    const query = { bbox: [-1,-1,1,1] as const, includeUncertainAccess: true };
    const coldStarted = performance.now();
    const first = await repository.getAccessPointCandidates(query);
    const coldMs = performance.now()-coldStarted;
    expect(first).toHaveLength(count);
    expect(first.every(point => point.regionIds?.length === 4)).toBe(true);
    expect(parseNode).not.toHaveBeenCalled();
    const isIndex = (sql:string) => sql.includes("SELECT a.id, a.node_id, a.access_state");
    const isCandidates = (sql:string) => sql.includes("candidate_lon");
    expect(nativeCalls.filter(isIndex)).toHaveLength(20); // 4 regions × ceil(1200/256)
    expect(nativeCalls.filter(isCandidates)).toHaveLength(5); // one pinned owner
    nativeCalls.length = 0;
    const warmStarted = performance.now();
    const repeated = await repository.getAccessPointCandidates(query);
    const warmMs = performance.now()-warmStarted;
    expect(repeated).toEqual(first);
    expect(nativeCalls.filter(isIndex)).toHaveLength(0);
    expect(nativeCalls.filter(isCandidates)).toHaveLength(5);
    const half = await repository.getAccessPointCandidates({ ...query, bbox: [0,-1,1,1] });
    expect(half).toEqual(first.filter(point => point.lon >= 0));
    expect(parseNode).not.toHaveBeenCalled();
    expect(repository.connectionStats).toEqual({ open: 4, peak: 4, limit: 8 });
    console.info(`many-start reader: ${count} starts, 4 overlapping regions, ${indexPayloadBytes} bytes of admission-row JSON, cold ${coldMs.toFixed(1)} ms, warm ${warmMs.toFixed(1)} ms; cold 20 index + 5 candidate batches, warm 0 index + 5 candidate batches, 0 deep node reads`);
  } finally { parseNode.mockRestore(); prepare.mockRestore(); }
},15_000);
