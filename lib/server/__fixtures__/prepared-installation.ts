import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promoteGraphFixture } from "@/lib/graph/test-helpers";
import { packManifestSchema, type CoverageInstallation, type DataRelease } from "@/lib/contracts";
import { compilePack } from "@/lib/data/testing/compiler";
import { fixtureCompileOptions } from "@/lib/data/fixture-pack";
import { listSearchRegions, getSearchRegion } from "@/lib/data/named-area-catalog";

/** Committed-source baseline promoted solely for prepared runtime integration tests. */
export async function preparedInstallation(root: string) {
  const artifact = await compilePack(await fixtureCompileOptions(join(root, "baseline"), undefined, undefined, undefined, {
    searchRegions: { version: 1, regions: [{ namedAreaId: "osm:relation/1001", expectedName: "Redwood Preserve" }] },
  }));
  const manifest = packManifestSchema.parse(JSON.parse(await readFile(artifact.manifestPath, "utf8")));
  const releaseId = "fixture-release";
  const path = join(root, "prepared.sqlite");
  await copyFile(artifact.databasePath, path);
  const regions = listSearchRegions(path).map(({ id, name }) => ({
    id, name, geometry: getSearchRegion(path, id)!.geometry,
    aliases: [`fixture-pack::${id}`], sourceIds: ["fixture"],
  }));
  promoteGraphFixture(path, releaseId);
  const bytes = await readFile(path), id = createHash("sha256").update(bytes).digest("hex");
  const release: DataRelease = {
    schemaVersion: 1, graphSchemaVersion: "7", id: releaseId, builtAt: manifest.builtAt,
    compilerVersion: manifest.compilerVersion, metricAlgorithmVersion: manifest.metricAlgorithmVersion,
    sources: manifest.sources, geometry: manifest.coverage.boundary, regions, limitations: [],
    sections: [{ id: "fixture-section", geometry: manifest.coverage.boundary, artifactIds: [id] }],
    artifacts: [{ id, path: `objects/${id}.sqlite.gz`, compressedBytes: bytes.length, bytes: bytes.length, geometry: manifest.coverage.boundary }],
  };
  const installation: CoverageInstallation = {
    id: "fixture-installation", releaseId, createdAt: manifest.builtAt, sectionIds: ["fixture-section"],
    artifactIds: [id], geometry: manifest.coverage.boundary,
  };
  for (const directory of ["artifacts", "releases", "installations"]) await mkdir(join(root, directory), { recursive: true });
  await copyFile(path, join(root, "artifacts", `${id}.sqlite`));
  await writeFile(join(root, "releases", `${releaseId}.json`), JSON.stringify(release));
  await writeFile(join(root, "installations", `${installation.id}.json`), JSON.stringify(installation));
  await writeFile(join(root, "current.json"), JSON.stringify({ installationId: installation.id }));
  return { installation, release, manifest };
}
