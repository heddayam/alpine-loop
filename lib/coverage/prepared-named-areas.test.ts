import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { rectangle } from "./geometry";
import { preparedNamedAreas } from "./named-areas";
import { readOsmSourceConfig } from "@/lib/data/osm/source";
import { prepareOsmNamedAreas } from "@/lib/data/osm/named-areas";
import { runCommand } from "@/lib/data/osm/command";
vi.mock("./collections",()=>({legacyRegionIds:["central-cascades"]}));
vi.mock("@/lib/data/osm/named-areas",()=>({prepareOsmNamedAreas:vi.fn()}));
vi.mock("@/lib/data/osm/command",()=>({runCommand:vi.fn()}));
it("resolves reviewed names and aliases from pinned sources with no installed pack",async()=>{
  const preparationRoot=await mkdtemp(path.join(tmpdir(),"prepared-regions-"));
  const config=await readOsmSourceConfig("data/regions/central-cascades/osm-source.json");
  const source={id:config.id,authority:"Fixture",dataset:"Search regions",version:"1",retrievedAt:"2026-09-24T00:00:00Z",url:"https://example.invalid/source",license:"CC0-1.0",contentHash:`sha256:${"1".repeat(64)}` as const,localPath:"fixture.pbf"};
  const geometry=rectangle([-123,45,-120,50]);
  vi.mocked(prepareOsmNamedAreas).mockResolvedValue([
    ["6115914","Glacier Peak Wilderness"],["6112652","Alpine Lakes Wilderness"],["6437099","Teanaway Community Forest"],
  ].map(([id,name])=>({id:`osm:relation/${id}`,name:name!,kind:"protected-area",aliases:[`${name} alias`],sourceIds:[source.id],bbox:[-123,45,-120,50],geometry})));
  try {
    const result=await preparedNamedAreas({geometry,sources:[source],snapshots:[source],preparationRoot});
    expect(result.searchRegions).toHaveLength(4);
    expect(result.namedAreas.map(area=>area.name)).toEqual(["Central Cascades","Glacier Peak Wilderness","Alpine Lakes Wilderness","Teanaway Community Forest"]);
    expect(result.namedAreas[1]!.aliases).toContain("Glacier Peak Wilderness alias");
    expect(runCommand).toHaveBeenCalledWith("osmium",expect.arrayContaining(["getid","--add-referenced","fixture.pbf","r6115914","r6112652","r6437099"]));
  } finally {await rm(preparationRoot,{recursive:true,force:true});}
});
