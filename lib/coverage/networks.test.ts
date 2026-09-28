import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import type { CuratedAccessFile } from "@/lib/data/curated-access";
import type { NormalizedWay } from "@/lib/data/types";
import { NetworkInventory } from "./networks";
import type { CoverageSourceStore } from "./source-store";
import { rectangle } from "./geometry";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true }); });
const way = (id: string, points: Array<[
    string,
    number,
    number
]>, extra: Partial<NormalizedWay> = {}): NormalizedWay => ({ id, externalId: id, nodeIds: points.map(p => p[0]), coordinates: points.map(p => [p[1], p[2]]), name: null, accessState: "public", bidirectional: true, edgeClass: "trail", sourceRefs: ["fixture"], flags: [], ...extra });
const source = (ways: NormalizedWay[]) => ({ *ways() { for (const item of ways)
        yield { way: item, nodes: item.nodeIds.map((id, i) => ({ id, externalId: id, lon: item.coordinates[i]![0], lat: item.coordinates[i]![1], elevationM: null, sourceRefs: item.sourceRefs, flags: [] })) }; } }) as Pick<CoverageSourceStore, "ways">;
async function discover(ways: NormalizedWay[], requested = rectangle([0.9, 0.9, 1.1, 1.1]), supported = rectangle([0, 0, 10, 10]), restrictions: CuratedAccessFile[] = [], checkpoint = async () => { }) {
    const root = await mkdtemp(path.join(tmpdir(), "networks-test-"));
    roots.push(root);
    const inventory = new NetworkInventory(path.join(root, "inventory.sqlite"));
    try {
        return await inventory.discover([source(ways)], supported, requested, restrictions, checkpoint);
    }
    finally {
        inventory.close();
    }
}
it("selection retains complete networks and acyclic approaches beyond the selected area", async () => {
    const ways = [way("loop", [["a", 1, 1], ["b", 3, 1], ["c", 2, 3], ["a", 1, 1]]), way("stem", [["b", 3, 1], ["d", 6, 1]]), way("other", [["x", 8, 8], ["y", 9, 8]])];
    const selected = await discover(ways);
    expect(selected).toHaveLength(1);
    expect(selected[0]).toMatchObject({ nodeCount: 4, physicalEdgeCount: 4, sourceBoundaryLimited: false });
    expect(JSON.stringify(selected[0]!.geometry)).toContain("6.0000001");
    expect(await discover(ways, rectangle([5.9, 0.9, 6.1, 1.1]))).toEqual(selected);
});
it("disconnected additions do not change an existing identity, but a source-identity connector does", async () => {
    const first = way("first", [["a", 1, 1], ["b", 2, 1]]), second = way("second", [["c", 4, 1], ["d", 5, 1]]);
    const original = await discover([first]);
    expect(await discover([first, second])).toEqual(original);
    expect((await discover([first, second, way("join", [["b", 2, 1], ["c", 4, 1]])]))[0]!.id).not.toBe(original[0]!.id);
});
it("coincident coordinates and roads never synthesize trail connections; unknown trails do", async () => {
    const a = way("a", [["a", 1, 1], ["b", 2, 1]]), b = way("b", [["c", 2, 1], ["d", 3, 1]]);
    const request = rectangle([0, 0, 4, 2]);
    expect(await discover([a, b], request)).toHaveLength(2);
    expect(await discover([a, b, way("road", [["b", 2, 1], ["c", 2, 1]], { edgeClass: "street" })], request)).toHaveLength(2);
    expect(await discover([a, b, way("unknown", [["b", 2, 1], ["c", 2, 1]], { accessState: "unknown" })], request)).toHaveLength(1);
    expect(await discover([a, b, way("closed", [["b", 2, 1], ["c", 2, 1]], { accessState: "closed" })], request)).toHaveLength(2);
});
it("discloses cuts at supported boundaries instead of claiming natural completeness", async () => {
    const result = await discover([way("crossing", [["a", 1, 1], ["b", 2, 1], ["c", 11, 1]])]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ physicalEdgeCount: 1, sourceBoundaryLimited: true });
});
it("deduplicates overlapping source records and rejects conflicting topology", async () => {
    const a = way("a", [["a", 1, 1], ["b", 2, 1]]);
    expect(await discover([a, a])).toEqual(await discover([a]));
    await expect(discover([a, { ...a, coordinates: [[1, 1], [2.1, 1]] }])).rejects.toThrow("Conflicting overlapping source");
});
it("applies reviewed restrictions before partitioning", async () => {
    const a = way("a", [["a", 1, 1], ["b", 2, 1]]), b = way("b", [["c", 3, 1], ["d", 4, 1]]), join = way("join", [["b", 2, 1], ["c", 3, 1]]);
    const restrictions: CuratedAccessFile[] = [{ snapshot: { id: "review", authority: "Fixture", dataset: "Access review", version: "1", retrievedAt: "2026-09-28T00:00:00Z", url: "https://example.invalid/access", license: "CC0", contentHash: `sha256:${"0".repeat(64)}`, localPath: "fixture" }, restrictions: [{ externalId: "join", accessState: "closed", reason: "reviewed closure", review: { reviewedAt: "2026-09-28T00:00:00Z", reviewer: "fixture" } }] }];
    const selected = rectangle([0, 0, 5, 2]);
    expect(await discover([a, b, join], selected)).toHaveLength(1);
    expect(await discover([a, b, join], selected, rectangle([0, 0, 10, 10]), restrictions)).toHaveLength(2);
});
it("honors cancellation while scanning a source network", async () => {
    const points: Array<[
        string,
        number,
        number
    ]> = Array.from({ length: 1200 }, (_, i) => [`node-${i}`, 1 + i / 1000, 1]);
    let checkpoints = 0;
    await expect(discover([way("long", points)], rectangle([0, 0, 5, 2]), rectangle([0, 0, 10, 10]), [], async () => { if (++checkpoints === 2)
        throw new Error("cancelled"); })).rejects.toThrow("cancelled");
    expect(checkpoints).toBe(2);
});
