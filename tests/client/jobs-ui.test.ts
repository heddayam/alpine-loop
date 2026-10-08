import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { JobSnapshot, RouteLocation } from "../../src/model.js";
import { JobsDialog, jobAreaSummary, jobTitle, savedResultsURL } from "../../src/client/JobsDialog.js";
import {
  startPoints,
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
  bounds: [x, y, x, y],
  trailNames: [],
  distance: 1000,
  gain: 100,
  roadDistance: 0,
  repetition: 0,
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
      expect(renderJob(status)).not.toContain('aria-label="Delete"');
    }
    for (const status of ["failed", "cancelled", "interrupted"] as const) {
      expect(renderJob(status)).toContain("Unfinished results were discarded.");
      expect(renderJob(status)).toContain('aria-label="Delete"');
      expect(renderJob(status)).not.toContain("View results");
    }
    expect(renderJob("completed")).toContain("View results");
    expect(renderJob("completed")).toContain('<td class="job-number">0</td>');
    const multipleRegions = { ...job("completed"), query: { ...job("completed").query, sections: ["one", "two"] } };
    expect(jobTitle(multipleRegions, id => id === "one" ? "Olympics" : "Cascades")).toContain("Olympics, Cascades;");
    expect(jobTitle(multipleRegions, id => id)).not.toContain("[object Object]");
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
  it("summarizes prepared state and mountain groups without guessing unknown sections", () => {
    const sections = [
      { id: "north", name: "North Cascades", state: "WA", regionId: "cascades", regionName: "Cascades" },
      { id: "south", name: "South Cascades", state: "WA", regionId: "cascades", regionName: "Cascades" },
      { id: "ca", name: "California Cascades", state: "CA", regionId: "cascades", regionName: "Cascades" },
    ];
    const selected = { ...job("completed"), query: { ...job("completed").query, sections: ["north", "south"] } };
    expect(jobAreaSummary(selected, sections)).toBe("WA Cascades");
    expect(jobAreaSummary({ ...selected, query: { ...selected.query, sections: ["north", "ca", "old"] }, regions: [{ id: "old", name: "Old region" }] }, sections)).toBe("WA Cascades, CA Cascades, Old region");
    expect(jobAreaSummary({ ...selected, regions: sections })).toBe("WA Cascades");
    expect(jobAreaSummary({ ...selected, regions: sections }, sections.map(section => ({ ...section, regionName: "Renamed" })))).toBe("WA Cascades");
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
  it("groups only exact shared starts before proximity clustering, preserving every hike", () => {
    const locations = [location("a", 0), location("b", 0), location("nearby", 0.001)];
    const points = startPoints(locations);
    expect(points).toHaveLength(2);
    expect(points[0]!.routes.map(route => route.id)).toEqual(["a", "b"]);
    expect(points[1]!.routes.map(route => route.id)).toEqual(["nearby"]);
    expect(points[1]!.position).toEqual(locations[2]!.startPosition);
    expect(points.flatMap(point => point.routes).map(route => route.id).sort()).toEqual(["a", "b", "nearby"]);
    expect(startPoints([...locations].reverse())).toEqual(points);
  });
  it("shows only the selected hike at its exact start and restores all choices on clear", () => {
    const locations = [location("a", 0), location("b", 0), location("nearby", 30)];
    const before = structuredClone(locations);
    const selected = startPoints(locations, "b");
    expect(selected).toHaveLength(1);
    expect(selected[0]!.routes).toEqual([locations[1]]);
    expect(selected[0]!.position).toEqual(locations[1]!.startPosition);
    expect(startPoints(locations, null).flatMap(point => point.routes)).toEqual(locations);
    expect(startPoints(locations, "missing")).toEqual([]);
    expect(locations).toEqual(before);
  });
});
