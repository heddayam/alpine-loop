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
  expect(output).toContain("Section preparation: 3 / 8 (37%) · 5 remaining");
  expect(output).toContain("Error: Missing source");
});

it("keeps finalization separate from section progress and labels extrapolated timing", () => {
  const stageTimings=Array.from({length:8},(_,i)=>({stage:`Prepared q-${i}`,elapsedMs:i*10000,durationMs:10000}));
  const text=formatBuildStatus({status:"running",currentStage:"Preparing installation unit q-9",elapsedMs:80000,completedUnits:8,totalUnits:10,stageTimings},100000,100000);
  expect(text).toContain("8 / 10 (80%) · 2 remaining");
  expect(text).toContain("Graph finalization, audit and export: pending");
  expect(text).toContain("~0m 20s–0m 20s (rough; finalization excluded)");
});
