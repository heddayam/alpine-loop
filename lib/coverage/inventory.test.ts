import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { openProgressiveGraphStore } from "@/lib/data/progressive/store";
import { compiledEdgesForSegment } from "@/lib/data/compiled-edges";
import type { SourceSnapshot } from "@/lib/data/adapters";
import { CoverageSourceStore } from "./source-store";
import { rectangle } from "./geometry";
import { reconcileInventory } from "./inventory";

const dispose: Array<() => void> = [];
afterEach(() => { for (const close of dispose.splice(0).reverse()) close(); });
async function fixture(lines: string[]) {
  const directory = mkdtempSync(path.join(tmpdir(), "network-inventory-"));
  const source: SourceSnapshot = {id:"fixture",authority:"fixture",dataset:"fixture",version:"1",retrievedAt:"2026-09-24",url:"https://example.invalid",license:"CC0",localPath:"unused",contentHash:`sha256:${"1".repeat(64)}`};
  const raw = new CoverageSourceStore(":memory:", source);
  const graph = openProgressiveGraphStore({stagingPath:path.join(directory,"graph.sqlite"),buildIdentity:"fixture"});
  dispose.push(() => { raw.close(); graph.close(); rmSync(directory,{recursive:true,force:true}); });
  async function* input() { yield* lines; }
  await raw.import(async () => {}, {lines:input()});
  const envelope = rectangle([-2,-2,3,3]);
  const audit = (included: (id: string) => boolean, checkpoint = async () => {}) => reconcileInventory(raw,graph,envelope,checkpoint,included,[]);
  const add = (externalId: string, segment = 0) => {
    const way = [...raw.ways(envelope)].find(item => item.way.externalId === externalId)!.way;
    const metrics = {lengthM:100,gainM:0,lossM:0,maxElevationM:100,maxSustainedGradePct:0,elevationProfile:null};
    for (const edge of compiledEdgesForSegment(way,segment,way.coordinates.slice(segment,segment+2),metrics)) graph.putEdge(edge);
    return `${way.id}:${segment}`;
  };
  return {raw,graph,source,envelope,audit,add};
}
it("audits only exact members inside overlapping network envelopes and catches missing directions", async () => {
  const f = await fixture(["n1 T x0 y0","n2 T x1 y0","n3 T x2 y0","w10 Thighway=path Nn1,n2,n3","w11 Thighway=path Nn1,n3"]);
  const id = f.add("way/10");
  expect(await f.audit(value => value === id)).toEqual({sourceId:"fixture",coveredSegments:1});
  f.graph.database.prepare("DELETE FROM edges WHERE id=?").run(`${id}:reverse`);
  await expect(f.audit(value => value === id)).rejects.toThrow("Unexplained compiler loss");
});
it("ignores stale geographic dispositions instead of silently hiding lost members", async () => {
  const f = await fixture(["n1 T x0 y0","n2 T x1 y0","w10 Thighway=path Nn1,n2"]);
  f.raw.db.prepare("UPDATE inventory SET disposition='excluded',reason='intentionally-excluded:old-policy'").run();
  await expect(f.audit(() => true)).rejects.toThrow("Unexplained compiler loss");
  f.add("way/10");
  expect(await f.audit(() => true)).toEqual({sourceId:"fixture",coveredSegments:1});
});
it("rejects forbidden selected members while allowing unrelated restricted trails", async () => {
  const f = await fixture(["n1 T x0 y0","n2 T x1 y0","w10 Thighway=path,access=private Nn1,n2","w11 Thighway=path Nn1,n2"]);
  const id = f.add("way/11");
  expect((await f.audit(value => value === id)).coveredSegments).toBe(1);
  await expect(f.audit(() => true)).rejects.toThrow("Forbidden source segment");
  const restrictions = [{snapshot:{...f.source,id:"review"},restrictions:[{externalId:"way/11",accessState:"closed" as const,reason:"Closure",review:{reviewedAt:"2026-09-24T00:00:00Z",reviewer:"Fixture"}}]}];
  await expect(reconcileInventory(f.raw,f.graph,f.envelope,async()=>{},value=>value===id,restrictions)).rejects.toThrow("Forbidden source segment");
});
it("interrupts inside a long source way and restarts without accumulated scratch tables", async () => {
  const lines: string[] = [];
  for (let i=1;i<=1501;i++) lines.push(`n${i} T x${i%2} y0.5`);
  lines.push(`w1 Thighway=path N${Array.from({length:1501},(_,i)=>`n${i+1}`).join(",")}`);
  const f = await fixture(lines);
  let checks = 0;
  await expect(f.audit(()=>false,async()=>{if(++checks===2)throw new Error("pause");})).rejects.toThrow("pause");
  expect(await f.audit(()=>false)).toEqual({sourceId:"fixture",coveredSegments:0});
  expect(f.raw.db.prepare("SELECT name FROM sqlite_master WHERE name IN ('coverage_frontiers','coverage_crossing_segments')").all()).toEqual([]);
});
