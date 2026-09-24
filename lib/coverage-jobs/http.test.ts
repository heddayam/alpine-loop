import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { CoverageCatalog, CoveragePlan } from "@/lib/contracts/coverage";
import { handleCoverageJobs, handleCoveragePlan, handleCoverageAction } from "./http";
import { CoverageJobService } from "./service";

const area: CoveragePlan["geometry"] = { type: "Polygon", coordinates: [[[0,0],[1,0],[1,1],[0,1],[0,0]]] };
const request = { collectionIds: ["test"], memoryLimitMiB: 1024, offline: true };
const plan: CoveragePlan = {
  id: "plan-1", request, geometry: area, units: [], sourceIds: [],
  estimates: { downloadBytes: 0, temporaryBytes: 0, reusableBytes: 0 }, warnings: [],
};
const catalog: CoverageCatalog = { collections: [], installed: null, jobs: [], prerequisites: [] };
const dirs: string[] = [];
const services: CoverageJobService[] = [];
afterEach(() => { services.splice(0).forEach((s) => s.close()); dirs.splice(0).forEach((dir) => rmSync(dir,{recursive:true,force:true})); });
function service(): CoverageJobService {
  const dir = mkdtempSync(join(tmpdir(),"coverage-http-")); dirs.push(dir);
  const value = new CoverageJobService({ dbPath: join(dir,"jobs.sqlite"), runtime: { catalog: async () => catalog, plan: async () => plan }, startWorker: () => {} });
  services.push(value); return value;
}

it("rejects cross-origin and non-loopback mutations before storing plans or jobs", async () => {
  const value = service();
  const cross = new Request("http://localhost/api/coverage/plan", { method: "POST", headers: { origin: "https://evil.example" }, body: JSON.stringify(request) });
  expect((await handleCoveragePlan(cross,value)).status).toBe(403);
  const remote = new Request("https://example.org/api/coverage/plan", { method: "POST", body: JSON.stringify(request) });
  expect((await handleCoveragePlan(remote,value)).status).toBe(403);
  expect(value.list()).toEqual([]);
  const same = new Request("http://localhost/api/coverage/plan", { method: "POST", headers: { origin: "http://localhost" }, body: JSON.stringify(request) });
  expect((await handleCoveragePlan(same,value)).status).toBe(200);
  const created = await handleCoverageJobs(new Request("http://localhost/api/coverage/jobs", { method: "POST", body: JSON.stringify({ planId: plan.id }) }), value);
  expect(created.status).toBe(202);
  const job = await created.json();
  const blocked = await handleCoverageAction(new Request("http://localhost/api/coverage/jobs/id/pause", { method: "POST", headers: { "sec-fetch-site": "cross-site" } }), job.id, "pause", value);
  expect(blocked.status).toBe(403);
  expect(value.get(job.id)?.status).toBe("queued");
});

it("uses the loopback browser authority behind a Docker port mapping", async () => {
  const value = service();
  const post = (host: string, origin: string) => handleCoveragePlan(new Request("http://0.0.0.0:3000/api/coverage/plan", {
    method: "POST", headers: { host, origin }, body: JSON.stringify(request),
  }), value);
  expect((await post("localhost:3105", "http://localhost:3105")).status).toBe(200);
  expect((await post("localhost:3105", "http://localhost:3000")).status).toBe(403);
  expect((await post("evil.example:3105", "http://evil.example:3105")).status).toBe(403);
});
