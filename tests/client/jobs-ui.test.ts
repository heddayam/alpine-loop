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
  query: Partial<JobSnapshot["query"]> = {},
  options: { loading?: boolean; empty?: boolean; canManage?: boolean } = {},
) =>
  renderToStaticMarkup(
    createElement(JobsDialog, {
      open: true,
      jobs: options.empty ? [] : [
        { ...job(status), canManage: options.canManage, query: { ...job(status).query, ...query }, progress: { ...job(status).progress, ...progress } },
      ],
      loading: options.loading,
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
const action = (markup: string, name: string) =>
  markup.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)?.find(button =>
    button.includes(`aria-label="${name}"`) || button.endsWith(`>${name}</button>`),
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
  it("retains the job table during a completion refresh and shows loading only without rows", () => {
    const refresh = renderJob("completed", {}, {}, { loading: true });
    expect(refresh).not.toContain("Loading jobs…");
    expect(refresh).toContain('aria-busy="true"');
    expect(refresh).toContain("View results");
    expect(renderJob("queued", {}, {}, { loading: true, empty: true })).toContain("Loading jobs…");
  });
  it("distinguishes disabled optional limits from zero and legacy percentage constraints", () => {
    const off = renderJob("completed", {}, { repetition: 1, roads: { distance: 10000, fraction: 1 } });
    expect(off.match(/>Off<\/span>/g)).toHaveLength(2);
    for (const query of [
      { stem: 0, repetition: 1, roads: { distance: 0, fraction: 1 } },
      { repetition: 0.2, roads: { distance: 10000, fraction: 0.1 } },
      { stem: 500, repetition: 1 },
    ]) {
      expect(renderJob("completed", {}, query)).not.toContain(">Off</span>");
    }
  });
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
  it("keeps action positions available, gates invalid actions, and keeps zero-result completion ready", () => {
    for (const status of ["queued", "running"] as const) {
      expect(renderJob(status)).toContain(">Cancel</button>");
      expect(renderJob(status)).not.toContain("View results");
      expect(action(renderJob(status), "Delete")).toContain('disabled=""');
      expect(action(renderJob(status), "Cancel")).not.toContain('disabled=""');
      expect(action(renderJob(status, {}, {}, { canManage: false }), "Cancel")).toContain('disabled=""');
    }
    for (const status of ["failed", "cancelled", "interrupted"] as const) {
      expect(renderJob(status)).toContain("Unfinished results were discarded.");
      expect(renderJob(status)).toContain('aria-label="Delete"');
      expect(action(renderJob(status), "View results")).toContain('disabled=""');
      expect(action(renderJob(status), "Delete")).not.toContain('disabled=""');
    }
    expect(renderJob("completed")).toContain("View results");
    expect(action(renderJob("completed"), "View results")).not.toContain('disabled=""');
    expect(action(renderJob("completed", {}, {}, { canManage: false }), "Delete")).toContain('disabled=""');
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
      currentRegion: { id: "second", name: "Second region" },
      totalRegions: 5,
      completedRegions: ["first"],
    });
    expect(renderJob("running")).not.toContain('<td class="job-number">0</td>');
    expect(renderJob("running", { foundHikes: 0 })).toContain('<td class="job-number">0</td>');
    const live = renderJob("running", { foundHikes: 37 });
    expect(live).toContain('<td class="job-number">37</td>');
    expect(live).not.toContain("View results");
    expect(renderJob("failed", { foundHikes: 37 })).not.toContain('<td class="job-number">37</td>');
    expect(measured).toContain('value="25"');
    expect(measured).toContain('max="100"');
    expect(measured.match(/Region 2 of 5, 25%/g)).toHaveLength(2);
    expect(measured).not.toContain("regions finished");
    expect(renderJob("running", { stage: "saving", completedRegions: ["cascades"] })).toContain("Saving results");
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
