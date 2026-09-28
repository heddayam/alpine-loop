// @vitest-environment jsdom
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { NetworkCatalog } from "@/lib/coverage/discovery-catalog";
import source from "@/data/regions/north-cascades/osm-source.json";
import { writeNetworkPreview } from "./network-preview";

const directories: string[] = [];
afterEach(async () => { document.documentElement.innerHTML = ""; await Promise.all(directories.splice(0).map(directory => rm(directory, {recursive:true,force:true}))); });
function catalog(count = 3): NetworkCatalog {
  return {
    schemaVersion: 1, discoveryVersion: "connected-networks-v2", id: `discovery-${"0".repeat(32)}`, inputFingerprint: "0".repeat(64),
    recipe: {schemaVersion:1, sources:[{config:{...source,schemaVersion:1},geometry:{type:"Polygon",coordinates:[[[-123,47],[-121,47],[-121,49],[-123,49],[-123,47]]]},sha256:`sha256:${"0".repeat(64)}`}], exclusions:[],reviewedRegionIds:[],memoryLimitMiB:512,offline:true,limitations:[]},
    inventory: {file:"inventory.sqlite",sha256:`sha256:${"0".repeat(64)}`},
    networks: Array.from({length:count}, (_, index) => ({
      id:`network-${index.toString(16).padStart(32,"0")}`, root:`node-${index}`, nodeCount:index+2,physicalEdgeCount:index+2+(index%2), cycleRank:1+(index%2), lengthMeters:(index+1)*1000, sourceBoundaryLimited:index===0,
      geometry:{type:"Polygon",coordinates:[[[-123+index/100,47],[-122+index/100,47],[-122+index/100,48],[-123+index/100,48],[-123+index/100,47]]]},
    })),
  };
}
async function render(value = catalog(), filename = "catalog.json") {
  const directory = await mkdtemp(path.join(os.tmpdir(), "network-preview-")); directories.push(directory);
  const catalogPath = path.join(directory, filename), file = await writeNetworkPreview(value, catalogPath), html = await readFile(file,"utf8");
  document.documentElement.innerHTML = html;
  const script = document.querySelectorAll("script")[1]!.textContent!;
  // Exercise the exact offline browser program, with no external requests.
  new Function(script)();
  return {file,html,catalogPath,directory};
}
const get = <T extends HTMLElement = HTMLElement>(id:string) => document.getElementById(id)! as T;
const buttons = () => [...document.querySelectorAll<HTMLButtonElement>("#networks button")];
function change(id:string,value:string) { const input=get<HTMLInputElement>(id); input.value=value; input.dispatchEvent(new Event(id==="filter"?"input":"change")); }

describe("offline network inspection", () => {
  it("renders deterministic output atomically and shows full selected extent and honest metrics", async () => {
    const value=catalog(), result=await render(value);
    expect(buttons()[0]!.dataset.id).toBe(value.networks[2]!.id);
    buttons()[0]!.click();
    expect(get("map-caption").textContent).toContain("Full selected network extent: west -122.98000, south 47.00000, east -121.98000, north 48.00000");
    expect(get("details").textContent).toContain("3 km");
    expect(get("details").textContent).toContain(`npm run data -- build '${path.relative(process.cwd(),result.catalogPath)}' --network '${value.networks[2]!.id}'`);
    expect(document.body.textContent).toContain("unknown until built");
    expect(document.body.textContent).toContain("not a count of viable hike routes");
    expect(await readFile(await writeNetworkPreview(value,result.catalogPath),"utf8")).toBe(result.html);
    expect(await readdir(result.directory)).toEqual(["networks.html"]);
  });
  it("bounds rendered lists and extents, filters IDs and cycles, sorts and clears stale selection on paging", async () => {
    const value=catalog(205); value.networks[0]!.cycleRank=0;
    await render(value);
    expect(buttons()).toHaveLength(100); expect(document.querySelectorAll("#map rect")).toHaveLength(100);
    buttons()[0]!.click(); get("next").click();
    expect(get("details").textContent).not.toContain("Prepare this network");
    expect(get("page").textContent).toBe("Page 2 of 3");
    get("next").click(); expect(buttons()).toHaveLength(5);
    change("filter",value.networks[0]!.id); expect(buttons()).toHaveLength(1); buttons()[0]!.click();
    expect(get("details").textContent).toContain("no simple loops");
    expect(get("details").textContent).toContain("Source-boundary limited");
    get<HTMLInputElement>("loops").checked=true; get("loops").dispatchEvent(new Event("change"));
    expect(buttons()).toHaveLength(0); expect(get("map-caption").textContent).toBe("No network extents to display.");
    change("filter",""); change("sort","cycleRank");
    expect(buttons()[0]!.dataset.id).toBe(value.networks[1]!.id);
  });
  it("keeps source labels inert and shell-quotes catalog paths", async () => {
    const value=catalog(); value.recipe.sources[0]!.config.id='</script><img src=x onerror="globalThis.injected=true">&\u2028';
    const result=await render(value,"a' $(touch hacked).json");
    expect(result.html).not.toContain('<img src=x'); expect(document.querySelector("img")).toBeNull();
    expect(get("sources").textContent).toContain(value.recipe.sources[0]!.config.id);
    buttons()[0]!.click();
    expect(get("details").textContent).toContain("a'\"'\"' $(touch hacked).json'");
    expect(document.querySelectorAll("script")).toHaveLength(2);
    expect(document.querySelector("meta[http-equiv='Content-Security-Policy']")!.getAttribute("content")).toContain("default-src 'none'");
  });
  it("renders an empty discovery without invalid coordinate output", async () => {
    await render(catalog(0)); expect(get("count").textContent).toBe("0 matching / 0 total networks");
    expect(get("map-caption").textContent).toBe("No network extents to display.");
    expect(document.querySelector("main")!.textContent).not.toContain("Infinity");
  });
});
