import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { JobSnapshot, RouteView } from "../../src/model.js";
import { RouteCache } from "../../src/client/RouteCache.js";
import { FixedList } from "../../src/client/FixedList.js";
import { mergeJobs, pollActiveJobs } from "../../src/client/useJobs.js";

const job = (id: string, status: JobSnapshot["status"] = "completed"): JobSnapshot => ({
  id, status, createdAt: id, storageBytes: 0,
  query: { sections: [], distance: [0, 10000], gain: [0, 1000], repetition: 0.2, includeUnknown: true },
  progress: { stage: "searching", totalRegions: 1, completedRegions: [], elapsedMs: 1,
    expansions: 0, totalStarts: 1, completedStarts: 0 },
});
const route = (id: string, points = 1): RouteView => ({
  id, groupId: id, startId: id, startName: id, startKind: "trailhead",
  startPosition: [0, 0], trailNames: [], distance: 1000, gain: 100,
  repetition: 0, roadDistance: 0, kind: "loop", uncertain: false,
  geometry: Array.from({ length: points }, () => [0, 0, 0]),
});

describe("browser resource and reconnect budgets", () => {
  it("bounds saved metadata while retaining every active job and unchanged object identities", () => {
    const rows = Array.from({ length: 200 }, (_, i) => job(String(i).padStart(3, "0")));
    const active = job("000", "running");
    const bounded = mergeJobs([], [...rows, active]);
    expect(bounded).toHaveLength(51);
    expect(bounded).toContainEqual(active);
    expect(mergeJobs(bounded, structuredClone(bounded))).toBe(bounded);
    expect(bounded.filter((row) => row.status === "completed").at(-1)!.id).toBe("150");
  });

  it("polls only active metadata, then reads every disappeared job's terminal status", async () => {
    const calls: string[] = [];
    const signal = new AbortController().signal;
    const read = async (url: string, suppliedSignal: AbortSignal) => {
      calls.push(url);
      expect(suppliedSignal).toBe(signal);
      if (url === "/api/jobs/active") return [job("still-running", "running")];
      if (url.includes("deleted")) throw Object.assign(new Error("gone"), { status: 404 });
      return job(url.includes("failed") ? "failed" : "cancelled", url.includes("failed") ? "failed" : "cancelled");
    };
    const result = await pollActiveJobs(new Set(["still-running", "failed", "cancelled", "deleted"]), signal, read);
    expect(calls).toEqual(["/api/jobs/active", "/api/jobs/failed?inputs=false", "/api/jobs/cancelled?inputs=false", "/api/jobs/deleted?inputs=false"]);
    expect(result.map((row) => row.status)).toEqual(["running", "failed", "cancelled"]);
    await expect(pollActiveJobs(new Set(["failed"]), signal, async (url) => {
      if (url === "/api/jobs/active") return [];
      throw new Error("offline");
    })).rejects.toThrow("offline");
  });

  it("evicts expendable hover geometry by byte estimate and recency, without caching oversized walks", () => {
    const cache = new RouteCache(5000, 2);
    cache.add("a", route("a"));
    cache.add("b", route("b"));
    expect(cache.get("a")!.id).toBe("a");
    cache.add("c", route("c"));
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")!.id).toBe("a");
    cache.add("oversized", route("oversized", 100));
    expect(cache.get("oversized")).toBeUndefined();
    const bytes = new RouteCache(3000, 100);
    bytes.add("a", route("a"));
    bytes.add("b", route("b"));
    expect(bytes.get("a")).toBeUndefined();
    expect(bytes.get("b")!.id).toBe("b");
    bytes.clear();
    expect(bytes.get("b")).toBeUndefined();
  });

  it("keeps a large continuous result list's initial DOM proportional to its viewport", () => {
    const items = Array.from({ length: 10000 }, (_, i) => `hike-${i}`);
    const markup = renderToStaticMarkup(createElement(FixedList<string>, {
      items, rowHeight: 70,
      children: (item, index) => createElement("li", { key: item }, createElement("button", { "data-row": index }, item)),
    }));
    expect((markup.match(/data-row=/g) ?? []).length).toBeLessThan(20);
    expect(markup).toContain("hike-0");
    expect(markup).not.toContain("hike-9999");
    expect(markup).toContain("list-spacer");
  });
});
