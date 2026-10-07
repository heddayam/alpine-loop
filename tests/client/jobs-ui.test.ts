import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { JobSnapshot, RouteLocation } from "../../src/model.js";
import { JobsDialog, savedResultsURL } from "../../src/client/JobsDialog.js";
import {
  clusterLocations,
  locationsInView,
} from "../../src/client/clusters.js";

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
const renderJob = (
  status: JobSnapshot["status"],
  progress: Partial<JobSnapshot["progress"]> = {},
) =>
  renderToStaticMarkup(
    createElement(JobsDialog, {
      open: true,
      jobs: [
        { ...job(status), progress: { ...job(status).progress, ...progress } },
      ],
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

describe("saved-job interface boundaries", () => {
  it("filters by visible starting points, including viewport edges, without changing the saved results", () => {
    const locations = [
      location("west", -122, 47),
      location("east", -121, 48),
      location("inside", -121.5, 47.5),
      location("outside", -120, 47.5),
      location("south", -121.5, 46.9),
    ];
    expect(
      locationsInView(locations, [-122, 47, -121, 48]).map((route) => route.id),
    ).toEqual(["west", "east", "inside"]);
    expect(locationsInView(locations, [-123, 46, -119, 49])).toEqual(locations);
    expect(locations).toHaveLength(5);
  });
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
    expect(renderJob("completed")).not.toContain("Search deeper");
    expect(renderJob("completed")).not.toContain("Standard search");
    expect(renderJob("completed")).toContain(
      "No qualifying hikes were found by this search.",
    );
    expect(renderJob("queued")).toContain("Queue position 2");
    const measured = renderJob("running", {
      totalSearchPoints: 100,
      completedSearchPoints: 25,
    });
    expect(measured).toContain('value="25"');
    expect(measured).toContain('max="100"');
    expect(measured).toContain("25%");
    expect(measured).not.toContain("planned search steps");
    expect(measured).not.toContain("fully explored");
    expect(renderJob("completed")).not.toContain("fully explored");
    expect(renderJob("running")).toContain(
      'aria-label="Within-region search progress"',
    );
  });
  it("keeps saved result reads pinned to their selected publication", () => {
    const old = { id: "saved/job", resultsRevision: 0 };
    for (const path of [
      "results",
      "locations",
      "routes/route",
      "routes/route.gpx",
    ]) {
      const url = new URL(
        savedResultsURL(old, path, "?offset=50&group=hike"),
        "http://localhost",
      );
      expect(url.pathname).toBe(`/api/jobs/saved%2Fjob/${path}`);
      expect(url.searchParams.get("revision")).toBe("0");
      expect(url.searchParams.get("offset")).toBe("50");
      expect(url.searchParams.get("group")).toBe("hike");
    }
    expect(savedResultsURL({ id: "legacy" }, "results")).toContain(
      "revision=0",
    );
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
