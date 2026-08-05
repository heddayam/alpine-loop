import { describe, expect, it } from "vitest";
import { closedRouteBenchmarkOutputSchema } from "./closed-route-benchmark";

describe("closedRouteBenchmarkOutputSchema", () => {
  it("defines the stable 60-second oracle artifact", () => {
    const parsed = closedRouteBenchmarkOutputSchema.parse({
      formatVersion: 1,
      generatedAt: "2026-08-05T00:00:00Z",
      engine: "gate5-oracle",
      effort: "oracle-60s",
      deadlineMs: 60_000,
      pack: { id: "fixture", schemaVersion: "3", dataVersion: "fixture-v3" },
      cases: [{
        caseId: "simple-loop",
        oracleFeasible: true,
        exactCount: 1,
        diverseExactCount: 1,
        elapsedMs: 12,
        timeToFirstExactMs: 7,
        expandedStates: 4,
        directedValidationRejectionCount: 0,
        attachmentGroupCount: 1,
        probedAttachmentGroupCount: 1,
        topologyKinds: ["simple-loop"],
        routeIds: ["route-1"],
        truncationReasons: [],
      }],
    });
    expect(parsed.deadlineMs).toBe(60_000);
  });
});
