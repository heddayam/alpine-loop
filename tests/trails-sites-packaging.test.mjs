import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sites } from "../build/sites-vite-plugin.ts";

async function write(root, path, content) {
  const destination = join(root, path);
  await mkdir(join(destination, ".."), { recursive: true });
  await writeFile(destination, content);
}

test("Sites packages only production Yosemite geometry shards", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "alpine-trails-sites-"));
  context.after(() => rm(root, { recursive: true, force: true }));

  await write(root, ".openai/hosting.json", '{"project_id":"fixture"}\n');
  await write(
    root,
    "data/trails/generated/yosemite-stanislaus/segments/index.json",
    '{"shards":{}}\n',
  );
  await write(
    root,
    "data/trails/generated/yosemite-stanislaus/segments/a.ndjson",
    '{"id":"segment_a"}\n',
  );
  await write(root, "data/trails/generated/yosemite-stanislaus/qa.json", "{}\n");
  await write(
    root,
    "data/trails/generated/yosemite-stanislaus/segment-provenance/a.json",
    "{}\n",
  );
  await write(root, "data/trails/generated/bay-midpen/segments/index.json", "{}\n");

  const plugin = sites();
  await plugin.configResolved({ root, command: "build" });
  await plugin.closeBundle();

  assert.equal(
    await readFile(join(root, "dist/client/trails/yosemite-stanislaus/segments/a.ndjson"), "utf8"),
    '{"id":"segment_a"}\n',
  );
  await assert.rejects(access(join(root, "dist/client/trails/bay-midpen")));
  await assert.rejects(access(join(root, "dist/client/trails/yosemite-stanislaus/qa.json")));
  await assert.rejects(access(
    join(root, "dist/client/trails/yosemite-stanislaus/segment-provenance"),
  ));
  assert.equal(
    await readFile(join(root, "dist/.openai/hosting.json"), "utf8"),
    '{"project_id":"fixture"}\n',
  );
});
