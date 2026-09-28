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
  expect(output).toContain("Network preparation: 3 / 8 · 5 remaining");
  expect(output).toContain("Error: Missing source");
});

it("does not invent preparation, classification, export or ETA during discovery", () => {
  const text = formatBuildStatus({status:"running",currentStage:"Verifying source",elapsedMs:325000,completedUnits:0,totalUnits:0},325000,330000);
  expect(text).toContain("Phase: Verifying source");
  expect(text).toContain("Elapsed: 5m 30s");
  expect(text).not.toMatch(/0 \/ 0|Network preparation|classification|finalization|export|ETA/);
});
it("shows only reported network progress without extrapolating unequal network sizes", () => {
  const text = formatBuildStatus({status:"running",currentStage:"Preparing network-abc",elapsedMs:80000,completedUnits:8,totalUnits:10},100000,100000);
  expect(text).toContain("Network preparation: 8 / 10 · 2 remaining");
  expect(text).not.toMatch(/classification|export|ETA/);
});
