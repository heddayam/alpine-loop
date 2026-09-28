import { expect, it } from "vitest";
import { readSourceRecipe } from "./recipe";
import { networkCatalogId, networkCatalogSchema, NETWORK_DISCOVERY_VERSION, type NetworkCatalog } from "./discovery-catalog";
import { rectangle } from "./geometry";

async function fixture() {
  const recipe = await readSourceRecipe("data/coverage/recipes/washington.json");
  const contents: Omit<NetworkCatalog,"id"> = {
    schemaVersion:1, discoveryVersion:NETWORK_DISCOVERY_VERSION, inputFingerprint:"a".repeat(64), recipe,
    inventory:{file:"inventory.sqlite",sha256:`sha256:${"b".repeat(64)}`},
    networks:[{id:`network-${"c".repeat(32)}`,root:"osm:node/1",geometry:rectangle([0,0,1,1]),nodeCount:3,physicalEdgeCount:3,lengthMeters:300,cycleRank:1,sourceBoundaryLimited:false}],
  };
  return {...contents,id:networkCatalogId(contents)};
}
it("validates a round-tripped catalog and rejects modified network metadata", async () => {
  const catalog = await fixture();
  expect(networkCatalogSchema.parse(JSON.parse(JSON.stringify(catalog)))).toEqual(catalog);
  catalog.networks[0]!.lengthMeters++;
  expect(() => networkCatalogSchema.parse(catalog)).toThrow("identity failed verification");
});
it("rejects duplicate identities even when the catalog hash is recomputed", async () => {
  const catalog = await fixture();
  catalog.networks.push(catalog.networks[0]!);
  const {id:_,...contents} = catalog; void _;
  expect(() => networkCatalogSchema.parse({...contents,id:networkCatalogId(contents)})).toThrow("Duplicate network IDs");
});
it("rejects unsupported discovery versions and inventory path escapes", async () => {
  const catalog = await fixture();
  expect(() => networkCatalogSchema.parse({...catalog,discoveryVersion:"old"})).toThrow();
  expect(() => networkCatalogSchema.parse({...catalog,inventory:{...catalog.inventory,file:"../../inventory.sqlite"}})).toThrow();
});
