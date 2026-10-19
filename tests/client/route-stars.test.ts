import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobSnapshot, RouteLocation } from "../../src/model.js";
import { compareHikes, RouteDock } from "../../src/client/RouteDock.js";
import { readRouteStars, routeStarsKey } from "../../src/client/useRouteStars.js";

const location = (id: string, distance: number): RouteLocation => ({
  id, groupId: id, startId: id, startName: id, startPosition: [0, 0], bounds: [0, 0, 1, 1],
  trailNames: [id], distance, gain: 100, highPoint: 1000, roadDistance: 0, repetition: 0,
});
const job = { id: "one", resultsRevision: 0, query: { distance: [0, 10000], gain: [0, 1000] } } as JobSnapshot;
const pinned = location("pinned", 9000);
const ordinary = location("ordinary", 1000);
const render = (routes: RouteLocation[], collapsed = false, scope: "view" | "all" | ReadonlySet<string> = "view") =>
  renderToStaticMarkup(createElement(RouteDock, {
    job, regionNames: ["Olympics"], units: "imperial", hidden: false, routes,
    starredRoutes: [pinned], starsCollapsed: collapsed, total: 2, scope,
    selectedId: "pinned", previewId: null, loadingMap: false, onToggleStars() {}, onToggleStar() {}, onScope() {},
    onSelect() {}, onPreview() {}, onClear() {},
  }));

afterEach(() => vi.unstubAllGlobals());
describe("personal route pins", () => {
  it("orders measured high points in either direction, with stable ties and unknown heights last", () => {
    const routes = [
      { ...location("unknown-b", 1), highPoint: null },
      { ...location("zero", 5), highPoint: 0 },
      { ...location("high-b", 2), highPoint: 1000 },
      { ...location("negative", 4), highPoint: -20 },
      { ...location("high-a", 3), highPoint: 1000 },
      { ...location("unknown-a", 6), highPoint: null },
    ];
    expect([...routes].sort((a, b) => compareHikes(a, b, "highPoint")).map(route => route.id))
      .toEqual(["negative", "zero", "high-a", "high-b", "unknown-a", "unknown-b"]);
    expect([...routes].sort((a, b) => compareHikes(a, b, "highPoint", true)).map(route => route.id))
      .toEqual(["high-a", "high-b", "zero", "negative", "unknown-a", "unknown-b"]);
    expect(render([ordinary])).toContain('<option value="highPoint">High Point</option>');
  });
  it("shows all four summary metrics for regular and starred results, with unknown peaks labeled", () => {
    const html = render([ordinary]);
    for (const id of ["pinned", "ordinary"]) {
      const row = html.split(`id="hike-${id}"`)[1]!.split("</button>")[0]!;
      expect(row).toContain("mi</small>");
      expect(row).toContain("ft gain</small>");
      expect(row).toContain("3,281");
      expect(row).toContain("ft high point</small>");
      expect(row).toContain("mi approach</small>");
    }
    expect(render([{ ...ordinary, highPoint: null }])).toContain("High point unavailable because elevation data is incomplete");
  });
  it("keeps out-of-scope stars first and never duplicates them in the ordinary list", () => {
    for (const scope of ["view", "all", new Set(["ordinary"])] as const) {
      const html = render(scope === "all" ? [ordinary, pinned] : [ordinary], false, scope);
      expect(html.indexOf('id="hike-pinned"')).toBeLessThan(html.indexOf('id="hike-ordinary"'));
      expect(html.match(/id="hike-pinned"/g)).toHaveLength(1);
      expect(html).toContain('aria-controls="starred-routes"');
      expect(html).toContain('aria-expanded="true"');
    }
    const collapsed = render([ordinary, pinned], true);
    expect(collapsed).toContain('id="starred-routes" class="starred-list" hidden=""');
    expect(collapsed).toContain('aria-expanded="false"');
    expect(collapsed.match(/id="hike-pinned"/g)).toHaveLength(1);
    expect(collapsed).toContain('id="hike-ordinary"');
  });
  it("isolates preferences by saved search and publication", () => {
    expect(routeStarsKey({ id: "one" })).toBe(routeStarsKey(job));
    expect(routeStarsKey({ id: "two" })).not.toBe(routeStarsKey(job));
    expect(routeStarsKey({ ...job, resultsRevision: 1 })).not.toBe(routeStarsKey(job));
    vi.stubGlobal("localStorage", { getItem: (key: string) => key === routeStarsKey(job)
      ? JSON.stringify({ ids: ["pinned", "pinned"], collapsed: true }) : null });
    expect(readRouteStars(routeStarsKey(job))).toEqual({ ids: ["pinned"], collapsed: true });
    expect(readRouteStars(routeStarsKey({ id: "two" }))).toEqual({ ids: [], collapsed: false });
  });
  it("keeps results usable with damaged or unavailable browser storage", () => {
    for (const value of ["{", "null", '{"ids":[42]}']) {
      vi.stubGlobal("localStorage", { getItem: () => value });
      expect(readRouteStars("key")).toEqual({ ids: [], collapsed: false });
    }
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("Blocked"); } });
    expect(readRouteStars("key")).toEqual({ ids: [], collapsed: false });
  });
});
