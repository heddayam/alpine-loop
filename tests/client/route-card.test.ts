import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { JobSnapshot, Position, RouteView } from "../../src/model.js";
import { RouteCard } from "../../src/client/RouteCard.js";

const geometry: Position[] = [[0, 0, 100], [0.001, 0, 1000], [0.001, 0.001, 100], [0, 0, 100]];
const route: RouteView = {
  id: "route", groupId: "hike", startId: "start", startName: "Trailhead", startKind: "trailhead",
  startPosition: geometry[0]!, trailNames: ["Ridge Loop"], distance: 5000, gain: 50,
  roadDistance: 0, repetition: 0, kind: "loop", uncertain: false, geometry,
};
const job = { id: "job", resultsRevision: 0 } as JobSnapshot;
const render = (points = geometry, units: "imperial" | "metric" = "imperial") =>
  renderToStaticMarkup(createElement(RouteCard, {
    route: { ...route, geometry: points }, job, units, error: "", starred: false,
    onToggleStar() {}, onClose() {}, onRetry() {}, onProfileHover() {}, onTrailHover() {},
  }));

describe("selected hike statistics", () => {
  it("shows the highest interior elevation separately from gain in both unit systems", () => {
    const imperial = render();
    expect(imperial).toContain('High Point</th><td>3,281</td><td class="metric-unit">ft</td>');
    expect(render(geometry, "metric")).toContain('High Point</th><td>1,000</td><td class="metric-unit">m</td>');
    expect(imperial.indexOf("Elevation gain</th>")).toBeLessThan(imperial.indexOf("High Point</th>"));
    expect(imperial.indexOf("High Point</th>")).toBeLessThan(imperial.indexOf("Approach <span"));
  });

  it("preserves zero and below-sea-level peaks but withholds incomplete elevation", () => {
    expect(render([[0, 0, 0], [0.001, 0, 0]], "metric")).toContain('High Point</th><td>0</td>');
    expect(render([[0, 0, -50], [0.001, 0, -20]], "metric")).toContain('High Point</th><td>-20</td>');
    expect(render([[0, 0, 100], [0.001, 0], [0.002, 0, 200]]))
      .toContain('High Point</th><td title="Elevation data is incomplete">—</td>');
  });
});
