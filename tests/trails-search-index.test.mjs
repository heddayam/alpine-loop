import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildTrailSearchIndex } from "../scripts/trails/build-search-index.mjs";

const indexUrl = new URL("../app/trails/indexes/yosemite-stanislaus.json", import.meta.url);

test("the compact search index is deterministic and honors Gate C exceptions", async () => {
  const committed = JSON.parse(await readFile(indexUrl, "utf8"));
  const rebuilt = await buildTrailSearchIndex("yosemite-stanislaus");
  assert.deepEqual(rebuilt, committed);
  assert.equal(Object.keys(committed.trails).length, 282);
  assert.equal(
    committed.trails["named-trail_8fb704040434b8047e3edd34"].suppressed,
    true,
  );
  assert.equal(
    committed.trails["named-trail_67852acfa7dea387de91be6a"].routeClass,
    "advanced-climbing",
  );
  assert.match(
    committed.trails["named-trail_0fe1a07a5c313956682f89eb"].notices.join(" "),
    /seasonal winter use/i,
  );
  assert.equal("maxGradePct" in committed.trails["named-trail_67852acfa7dea387de91be6a"], false);
});
