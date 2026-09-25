import { expect, it } from "vitest";
import { formatBuildStatus } from "./data-status";

it("shows report age instead of implying an old report is a live heartbeat", () => {
  const output=formatBuildStatus({status:"running",currentStage:"Verifying sources",elapsedMs:60_000,completedUnits:0},120_000,240_000);
  expect(output).toContain("Last reported state: running");
  expect(output).toContain("Elapsed: 3m 0s");
  expect(output).toContain("Last report: 2m 0s ago");
});
it("preserves stopped build duration and displays its failure", () => {
  const output=formatBuildStatus({status:"failed",currentStage:"Preparing",elapsedMs:60_000,completedUnits:3,totalUnits:8,error:"Missing source"},120_000,240_000);
  expect(output).toContain("Elapsed: 1m 0s");
  expect(output).toContain("Sections prepared this run: 3 / 8");
  expect(output).toContain("Error: Missing source");
});
