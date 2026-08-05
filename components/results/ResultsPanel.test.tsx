// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GeneratedRoute, GenerateRoutesResponseV1 } from "@/lib/contracts";
import { ROUTE_PREVIEW_EVENT } from "../map/routeTraceOverlay";
import { ResultsPanel } from "./ResultsPanel";

function route(overrides: Partial<GeneratedRoute> = {}): GeneratedRoute {
  return {
    id: "exact-loop",
    shape: "loop",
    geometry: { type: "LineString", coordinates: [[-122.18, 37.15], [-122.16, 37.17], [-122.18, 37.15]] },
    startAccessPoint: { id: "start", name: "Saratoga Gap", lon: -122.18, lat: 37.15, accessState: "public", confidence: "high" },
    endAccessPoint: { id: "start", name: "Saratoga Gap", lon: -122.18, lat: 37.15, accessState: "public", confidence: "high" },
    distanceMeters: 8046.72,
    elevationGainMeters: 365.76,
    elevationLossMeters: 350,
    minimumElevationMeters: 420,
    maximumElevationMeters: 792.48,
    steepestSustainedGradePct: 12.4,
    repeatedEdgeFraction: 0,
    trailNames: ["Ridge Trail", "Charcoal Road"],
    warnings: ["Official access data is more than 30 days old."],
    source: { freshness: "2026-07-15T00:00:00Z", confidence: "high", sourceIds: ["osm", "midpen"] },
    elevationSamples: [
      { distanceMeters: 0, elevationMeters: 420 },
      { distanceMeters: 4000, elevationMeters: 792.48 },
      { distanceMeters: 8046.72, elevationMeters: 500 },
    ],
    ...overrides,
  };
}

function response(overrides: Partial<GenerateRoutesResponseV1> = {}): GenerateRoutesResponseV1 {
  return {
    version: 1,
    requestId: "request-results-1",
    pack: { id: "fixture-pack", schemaVersion: "1", dataVersion: "fixture-1", builtAt: "2026-08-01T00:00:00Z" },
    requested: 2,
    exact: [route()],
    nearMisses: [{
      ...route({ id: "near-out-back", shape: "out-and-back", distanceMeters: 3218.688, trailNames: ["Skyline Trail"], warnings: [] }),
      violations: [{
        constraint: "distance",
        value: 3218.688,
        min: 4828.032,
        max: 12874.752,
        delta: 1609.344,
        normalizedDelta: 0.2,
      }],
    }],
    diagnostics: { elapsedMs: 42.4, expandedStates: 1200, candidateCount: 18, exhausted: false, truncationReasons: [] },
    ...overrides,
  };
}

describe("ResultsPanel", () => {
  afterEach(cleanup);

  it("separates exact matches from near misses and discloses metrics, warnings, freshness, and violations", () => {
    render(<ResultsPanel status="done" response={response()} selectedRouteId="exact-loop" onSelectRoute={() => undefined} />);

    expect(screen.getByRole("heading", { name: "Exact matches" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Near misses" })).toBeVisible();
    const metrics = screen.getByRole("article", { name: "Loop" }).querySelector(".route-metrics");
    expect(metrics).not.toBeNull();
    expect(within(metrics as HTMLElement).getByText("5.0 mi")).toBeVisible();
    expect(within(metrics as HTMLElement).getByText("1,200 ft")).toBeVisible();
    expect(within(metrics as HTMLElement).getByText("2,600 ft")).toBeVisible();
    expect(within(metrics as HTMLElement).getByText("12.4%")).toBeVisible();
    expect(screen.getByText("Official access data is more than 30 days old.")).toBeVisible();
    expect(screen.getAllByText(/Data current Jul 15, 2026/)).toHaveLength(2);
    expect(screen.getAllByText("Sources: osm, midpen")).toHaveLength(2);
    expect(screen.getByText(/Distance: 2.0 mi; requested 3.0 mi–8.0 mi \(off by 1.0 mi\)/)).toBeVisible();
    expect(screen.getByText(/Planning aid only/)).toBeVisible();
  });

  it("synchronizes button selection and arrow-key focus", () => {
    const onSelect = vi.fn();
    render(<ResultsPanel status="done" response={response()} selectedRouteId="exact-loop" onSelectRoute={onSelect} />);
    const list = screen.getByLabelText("Generated routes");
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(onSelect).toHaveBeenCalledWith("near-out-back");
    expect(screen.getByRole("button", { name: /Out & back/ })).toHaveFocus();

    fireEvent.keyDown(list, { key: "Home" });
    expect(onSelect).toHaveBeenLastCalledWith("exact-loop");
    expect(screen.getByRole("button", { name: /Loop/ })).toHaveFocus();
  });

  it("previews a route trace from pointer hover and keyboard focus without changing selection", () => {
    const previews: Array<string | undefined> = [];
    const handlePreview = (event: Event) => previews.push((event as CustomEvent<{ routeId?: string }>).detail.routeId);
    window.addEventListener(ROUTE_PREVIEW_EVENT, handlePreview);

    render(<ResultsPanel status="done" response={response()} selectedRouteId="exact-loop" onSelectRoute={() => undefined} />);
    const exactCard = screen.getByRole("article", { name: "Loop" });
    const exactButton = within(exactCard).getByRole("button");
    fireEvent.mouseEnter(exactCard);
    fireEvent.mouseLeave(exactCard);
    fireEvent.focus(exactButton);
    fireEvent.blur(exactButton, { relatedTarget: document.body });

    expect(previews).toEqual(["exact-loop", undefined, "exact-loop", undefined]);
    expect(within(exactCard).getByText("1")).toBeVisible();
    window.removeEventListener(ROUTE_PREVIEW_EVENT, handlePreview);
  });

  it("shows optional elevation profiles only when samples exist", () => {
    const { rerender } = render(<ResultsPanel status="done" response={response({ nearMisses: [] })} selectedRouteId="exact-loop" onSelectRoute={() => undefined} />);
    expect(screen.getByRole("img", { name: /Elevation profile/ })).toBeVisible();

    rerender(<ResultsPanel status="done" response={response({ exact: [route({ elevationSamples: undefined })], nearMisses: [] })} selectedRouteId="exact-loop" onSelectRoute={() => undefined} />);
    expect(screen.queryByRole("img", { name: /Elevation profile/ })).not.toBeInTheDocument();
  });

  it("explains partial and no-result diagnostics without silently relaxing constraints", async () => {
    render(<ResultsPanel
      status="done"
      response={response({
        requested: 10,
        exact: [],
        nearMisses: [],
        diagnostics: { elapsedMs: 3000, expandedStates: 100000, candidateCount: 0, exhausted: true, truncationReasons: ["deadline"] },
      })}
      onSelectRoute={() => undefined}
    />);
    expect(screen.getByText("Search stopped at its safety budget.")).toBeVisible();
    expect(screen.getByText("Reason: time budget reached.")).toBeVisible();
    expect(screen.getByText("No routes found inside this boundary.")).toBeVisible();
    await userEvent.click(screen.getByText("Search diagnostics"));
    const diagnostics = screen.getByText("Search diagnostics").closest("details");
    expect(diagnostics).not.toBeNull();
    expect(within(diagnostics as HTMLElement).getByText("3,000 ms")).toBeVisible();
    expect(within(diagnostics as HTMLElement).getByText("100,000")).toBeVisible();
  });

  it("does not present a full exact result set as partial when diagnostic limits were reached", () => {
    render(<ResultsPanel
      status="done"
      response={response({
        requested: 1,
        exact: [route()],
        nearMisses: [],
        diagnostics: { elapsedMs: 2250, expandedStates: 100000, candidateCount: 500, exhausted: true, truncationReasons: ["deadline"] },
      })}
      onSelectRoute={() => undefined}
    />);

    expect(screen.queryByText("Search stopped at its safety budget.")).not.toBeInTheDocument();
    expect(screen.getByText("1 exact · 0 near misses")).toBeVisible();
  });

  it("announces loading, error, and cancelled generation states", () => {
    const { rerender } = render(<ResultsPanel status="loading" response={null} onSelectRoute={() => undefined} />);
    expect(screen.getByRole("status")).toHaveTextContent("Generating routes");

    rerender(<ResultsPanel status="error" response={null} message="Fixture pack is unavailable." onSelectRoute={() => undefined} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Fixture pack is unavailable.");

    rerender(<ResultsPanel status="cancelled" response={null} onSelectRoute={() => undefined} />);
    expect(screen.getByRole("status")).toHaveTextContent("No routes were changed");
  });
});
