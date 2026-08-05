// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { useState } from "react";
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

function ControlledResultsPanel() {
  const [selectedRouteId, setSelectedRouteId] = useState("exact-loop");
  return (
    <ResultsPanel
      status="done"
      response={response()}
      selectedRouteId={selectedRouteId}
      onSelectRoute={setSelectedRouteId}
    />
  );
}

describe("ResultsPanel", () => {
  afterEach(cleanup);

  it("renders compact exact and near-miss summaries while expanding only the selected route", () => {
    const { rerender } = render(<ResultsPanel status="done" response={response()} selectedRouteId="exact-loop" onSelectRoute={() => undefined} />);

    expect(screen.getByRole("heading", { name: "Exact matches" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Near misses" })).toBeVisible();
    const exactSummary = screen.getByRole("button", { name: /Loop/ });
    const nearSummary = screen.getByRole("button", { name: /Out & back/ });
    expect(exactSummary).toHaveAttribute("aria-expanded", "true");
    expect(nearSummary).toHaveAttribute("aria-expanded", "false");
    expect(within(exactSummary).getByText("5.0 mi")).toBeVisible();
    expect(within(exactSummary).getByText("1,200 ft")).toBeVisible();
    expect(within(exactSummary).getByText("12.4%")).toBeVisible();

    const selectedDetail = screen.getByRole("region", { name: /Ridge Trail.*Loop/ });
    expect(within(selectedDetail).getByRole("img", { name: /Elevation profile/ })).toBeVisible();
    expect(within(selectedDetail).queryByText("Elevation loss")).not.toBeVisible();
    expect(screen.queryByText(/requested 3.0 mi–8.0 mi/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Planning aid only/)).not.toBeInTheDocument();

    fireEvent.click(within(selectedDetail).getByText("Route details"));
    expect(within(selectedDetail).getByText("Elevation loss")).toBeVisible();
    expect(within(selectedDetail).getAllByText("2,600 ft")).toHaveLength(2);
    expect(within(selectedDetail).queryByText("Official access data is more than 30 days old.")).not.toBeInTheDocument();
    expect(within(selectedDetail).getByText("Data current Jul 15, 2026")).toBeVisible();
    expect(within(selectedDetail).getByText("Sources: osm, midpen")).toBeVisible();

    rerender(<ResultsPanel status="done" response={response()} selectedRouteId="near-out-back" onSelectRoute={() => undefined} />);
    expect(screen.queryByRole("region", { name: /Ridge Trail.*Loop/ })).not.toBeInTheDocument();
    const nearDetail = screen.getByRole("region", { name: /Skyline Trail.*Out & back/ });
    expect(within(nearDetail).queryByText(/requested 3.0 mi–8.0 mi/)).not.toBeInTheDocument();
    fireEvent.click(within(nearDetail).getByText("Route details"));
    expect(within(nearDetail).getByText("Source confidence:")).toBeVisible();
    expect(within(nearDetail).getByText("Sources: osm, midpen")).toBeVisible();
  });

  it("synchronizes expanded selection and arrow/Home/End keyboard focus", () => {
    render(<ControlledResultsPanel />);
    const list = screen.getByLabelText("Generated routes");
    fireEvent.keyDown(list, { key: "ArrowDown" });
    const nearSummary = screen.getByRole("button", { name: /Out & back/ });
    expect(nearSummary).toHaveFocus();
    expect(nearSummary).toHaveAttribute("aria-pressed", "true");
    expect(nearSummary).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("region", { name: /Skyline Trail.*Out & back/ })).toBeVisible();

    fireEvent.keyDown(list, { key: "Home" });
    const exactSummary = screen.getByRole("button", { name: /Loop/ });
    expect(exactSummary).toHaveFocus();
    expect(exactSummary).toHaveAttribute("aria-expanded", "true");

    fireEvent.keyDown(list, { key: "End" });
    expect(nearSummary).toHaveFocus();
    expect(nearSummary).toHaveAttribute("aria-expanded", "true");
  });

  it("shows and copies trailhead coordinates when a result is selected", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<ResultsPanel status="done" response={response()} selectedRouteId="exact-loop" onSelectRoute={() => undefined} />);

    const exactDetail = screen.getByRole("region", { name: /Ridge Trail.*Loop/ });
    const coordinates = within(exactDetail).getByRole("button", { name: "Copy trailhead coordinates 37.15000, -122.18000" });
    expect(coordinates).toBeVisible();
    expect(screen.getByRole("button", { name: /Skyline Trail/ })).not.toHaveTextContent("37.15000, -122.18000");
    await userEvent.click(coordinates);

    expect(writeText).toHaveBeenCalledWith("37.15000, -122.18000");
  });

  it("previews a route trace from pointer hover and keyboard focus without changing selection", () => {
    const previews: Array<string | undefined> = [];
    const handlePreview = (event: Event) => previews.push((event as CustomEvent<{ routeId?: string }>).detail.routeId);
    window.addEventListener(ROUTE_PREVIEW_EVENT, handlePreview);

    render(<ResultsPanel status="done" response={response()} selectedRouteId="exact-loop" onSelectRoute={() => undefined} />);
    const exactCard = screen.getByRole("article", { name: /Ridge Trail.*Loop/ });
    const exactButton = within(exactCard).getByRole("button", { name: /Ridge Trail/ });
    fireEvent.mouseEnter(exactCard);
    fireEvent.mouseLeave(exactCard);
    fireEvent.focus(exactButton);
    fireEvent.blur(exactButton, { relatedTarget: document.body });

    expect(previews).toEqual(["exact-loop", undefined, "exact-loop", undefined]);
    expect(within(exactCard).getByText("1")).toBeVisible();
    window.removeEventListener(ROUTE_PREVIEW_EVENT, handlePreview);
  });

  it("shows an optional elevation profile only in the selected detail", () => {
    const { rerender } = render(<ResultsPanel status="done" response={response()} selectedRouteId="exact-loop" onSelectRoute={() => undefined} />);
    expect(screen.getByRole("img", { name: /Elevation profile/ })).toBeVisible();
    expect(screen.getAllByRole("img", { name: /Elevation profile/ })).toHaveLength(1);

    rerender(<ResultsPanel status="done" response={response()} selectedRouteId="near-out-back" onSelectRoute={() => undefined} />);
    expect(screen.getAllByRole("img", { name: /Elevation profile/ })).toHaveLength(1);

    rerender(<ResultsPanel status="done" response={response({ exact: [route({ elevationSamples: undefined })], nearMisses: [] })} selectedRouteId="exact-loop" onSelectRoute={() => undefined} />);
    expect(screen.queryByRole("img", { name: /Elevation profile/ })).not.toBeInTheDocument();
  });

  it("omits generic partial-search warnings", async () => {
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
    expect(screen.queryByText("Search stopped at its safety budget.")).not.toBeInTheDocument();
    expect(screen.queryByText(/time budget reached/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "Partial results" })).not.toBeInTheDocument();
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
    expect(screen.queryByRole("img", { name: "Partial results" })).not.toBeInTheDocument();
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
