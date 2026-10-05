import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { JobSnapshot, RouteLocation } from "../../src/model.js";
import { JobsDialog } from "../../src/client/JobsDialog.js";
import { clusterLocations } from "../../src/client/clusters.js";

const job = (status: JobSnapshot["status"]): JobSnapshot => ({
  id: status,
  status,
  createdAt: "2026-10-05T12:00:00Z",
  storageBytes: 1234,
  queuePosition: 2,
  query: {
    sections: ["cascades"],
    distance: [0, 10000],
    gain: [0, 1000],
    repetition: 0.2,
    includeUnknown: true,
  },
  progress: {
    stage: "searching",
    totalRegions: 1,
    completedRegions: status === "completed" ? ["cascades"] : [],
    elapsedMs: 60000,
    expansions: 99,
    totalStarts: 10,
    completedStarts: 1,
  },
  ...(status === "completed" ? { groupCount: 0, routeCount: 0 } : {}),
});
const renderJob = (status: JobSnapshot["status"]) =>
  renderToStaticMarkup(
    createElement(JobsDialog, {
      open: true,
      jobs: [job(status)],
      regionName: () => "Cascades",
      highlightedId: null,
      error: "",
      pending: null,
      onClose: () => {},
      onRefresh: () => {},
      onView: () => {},
      onCopy: () => {},
      onAction: () => {},
    }),
  );
const location = (id: string, x: number, y = 0): RouteLocation => ({
  id,
  groupId: id,
  startId: id,
  startName: id,
  startPosition: [x, y],
  trailNames: [],
  distance: 1000,
});

describe("completed-job interface boundaries", () => {
  it("exposes results and deletion only for terminal jobs and keeps zero-result completion ready", () => {
    for (const status of ["queued", "running"] as const) {
      expect(renderJob(status)).toContain(">Cancel</button>");
      expect(renderJob(status)).not.toContain("View results");
      expect(renderJob(status)).not.toContain(">Delete</button>");
    }
    for (const status of ["failed", "cancelled", "interrupted"] as const) {
      expect(renderJob(status)).toContain("Unfinished results were discarded.");
      expect(renderJob(status)).toContain(">Delete</button>");
      expect(renderJob(status)).not.toContain("View results");
    }
    expect(renderJob("completed")).toContain("View results");
    expect(renderJob("completed")).toContain("0 hikes");
    expect(renderJob("queued")).toContain("Queue position 2");
  });
  it("clusters the entire location set deterministically and preserves all choices at a shared start", () => {
    const locations = Array.from({ length: 75 }, (_, i) =>
      location(`hike-${i}`, i < 3 ? 0 : i * 100),
    );
    const project = (route: RouteLocation) => ({
      x: route.startPosition[0],
      y: route.startPosition[1],
    });
    const clusters = clusterLocations(locations, project);
    expect(clusterLocations([...locations].reverse(), project)).toEqual(
      clusters,
    );
    expect(
      clusters
        .flatMap((cluster) => cluster.routes)
        .map((route) => route.id)
        .sort(),
    ).toEqual(locations.map((route) => route.id).sort());
    expect(
      clusters.find((cluster) => cluster.routes.length === 3),
    ).toMatchObject({ coincident: true });
    expect(
      clusters
        .flatMap((cluster) => cluster.routes)
        .some((route) => route.id === "hike-74"),
    ).toBe(true);
    expect(
      clusterLocations([location("a", 0), location("b", 30)], project)[0]!
        .coincident,
    ).toBe(false);
  });
});
