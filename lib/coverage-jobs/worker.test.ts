import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { CoveragePlan } from "@/lib/contracts/coverage";
import { SQLiteCoverageJobStore } from "./store";
import { runCoverageWorker } from "./worker";

const area: CoveragePlan["geometry"] = { type: "Polygon", coordinates: [[[0,0],[1,0],[1,1],[0,1],[0,0]]] };
const plan: CoveragePlan = {
  id: "plan-1", request: { collectionIds: ["test"], memoryLimitMiB: 1024, offline: true },
  geometry: area, units: [{ id: "unit-1", geometry: area, status: "pending" }], sourceIds: [],
  estimates: { downloadBytes: 0, temporaryBytes: 0, reusableBytes: 0 }, warnings: [],
};

it("runs outside the request and preserves checkpointed progress on failure", async () => {
  const dir = mkdtempSync(join(tmpdir(),"coverage-worker-"));
  try {
    const file = join(dir,"jobs.sqlite");
    const setup = new SQLiteCoverageJobStore(file);
    setup.savePlan(plan); setup.createJob(plan.id,"job-1"); setup.close();
    await runCoverageWorker(file,{ run: async (_plan, context) => {
      expect(context.publishOnly).toBe(false);
      expect(await context.checkpoint()).toBe("continue");
      await context.report({ stage: "Prepared", completedUnits: 1, units: [{ ...plan.units[0]!, status: "prepared" }] });
      throw new Error("fixture source failed");
    } });
    const check = new SQLiteCoverageJobStore(file);
    expect(check.getJob("job-1")).toMatchObject({ status: "failed", stage: "Failed", completedUnits: 1, error: "fixture source failed" });
    check.close();
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
