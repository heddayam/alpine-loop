// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GeneratedClosedRouteV3, GenerateClosedRoutesResponseV3 } from "@/lib/contracts";
import { ROUTE_PREVIEW_EVENT } from "../map/routeTraceOverlay";
import { ResultsPanel } from "./ResultsPanel";

function route(overrides: Partial<GeneratedClosedRouteV3> = {}): GeneratedClosedRouteV3 {
  return {
    id: "exact-loop",
    geometry: { type: "LineString", coordinates: [[-122.18, 37.15], [-122.16, 37.17], [-122.18, 37.15]] },
    startAccessPoint: { id: "start", name: "Saratoga Gap", lon: -122.18, lat: 37.15, accessState: "public", confidence: "high" },
    distanceMeters: 8046.72,
    elevationGainMeters: 365.76,
    elevationLossMeters: 350,
    minimumElevationMeters: 420,
    maximumElevationMeters: 792.48,
    steepestSustainedGradePct: 12.4,
    topology: {
      kind: "simple-loop",
      cycleCount: 1,
      cycleBlockCount: 1,
      repeatedTrailDistanceMeters: 0,
      repeatedTrailFraction: 0,
      sharedStemDistanceMeters: 0,
      connectorCount: 0,
    },
    trailNames: ["Ridge Trail", "Charcoal Road"],
    warnings: [],
    source: { freshness: "2026-07-15T00:00:00Z", confidence: "high", sourceIds: ["osm", "midpen"] },
    elevationSamples: [
      { distanceMeters: 0, elevationMeters: 420 },
      { distanceMeters: 4000, elevationMeters: 792.48 },
      { distanceMeters: 8046.72, elevationMeters: 500 },
    ],
    ...overrides,
  };
}

type ResponseOverrides = Omit<Partial<GenerateClosedRoutesResponseV3>, "diagnostics"> & {
  diagnostics?: Partial<GenerateClosedRoutesResponseV3["diagnostics"]>;
};

function response(overrides: ResponseOverrides = {}): GenerateClosedRoutesResponseV3 {
  const diagnostics: GenerateClosedRoutesResponseV3["diagnostics"] = {
    elapsedMs: 42.4,
    expandedStates: 1200,
    candidateCount: 18,
    eligibleAccessPointCount: 4,
    searchedAccessPointCount: 4,
    graphQueryCount: 4,
    maximumLoadedDirectedEdges: 900,
    exhausted: false,
    truncationReasons: [],
    shortfallReasons: [],
    noCycleAccessPointCount: 1,
    feasibleAccessPointCount: 3,
    attachmentGroupCount: 3,
    probedAttachmentGroupCount: 3,
    deeplySearchedAttachmentGroupCount: 3,
    loadedTopologyNetworkCount: 2,
    cycleBlockCount: 4,
    cyclePrimitiveCount: 12,
    composedCandidateCount: 8,
    repairedCandidateCount: 1,
    directedValidationRejectionCount: 0,
    expandedAssemblyStates: 400,
    timeToFirstExactMs: 12,
    hardTruncationReasons: [],
    nonBudgetShortfallReasons: ["fewer-exact-routes-than-requested"],
    ...overrides.diagnostics,
  };
  return {
    version: 3,
    requestId: "request-results-1",
    pack: { id: "fixture-pack", schemaVersion: "3", dataVersion: "fixture-3", builtAt: "2026-08-01T00:00:00Z" },
    requested: 2,
    resolvedAccessFilter: { mode: "drawn-area", label: "Drawn area" },
    exact: [route()],
    nearMisses: [{
      ...route({
        id: "near-lollipop",
        distanceMeters: 3218.688,
        trailNames: ["Skyline Trail"],
        topology: {
          kind: "lollipop",
          cycleCount: 1,
          cycleBlockCount: 1,
          repeatedTrailDistanceMeters: 800,
          repeatedTrailFraction: 0.25,
          sharedStemDistanceMeters: 400,
          connectorCount: 1,
        },
      }),
      violations: [{
        constraint: "distance",
        value: 3218.688,
        min: 4828.032,
        max: 12874.752,
        delta: 1609.344,
        normalizedDelta: 0.2,
      }],
    }],
    ...overrides,
    diagnostics,
  };
}

function ControlledResultsPanel() {
  const [selectedRouteId, setSelectedRouteId] = useState("exact-loop");
  return <ResultsPanel status="done" response={response()} selectedRouteId={selectedRouteId} onSelectRoute={setSelectedRouteId} />;
}

describe("ResultsPanel V3", () => {
  afterEach(cleanup);

  it("separates exact matches from labeled near misses and renders closed topology", () => {
    const { rerender } = render(<ResultsPanel status="done" response={response()} selectedRouteId="exact-loop" onSelectRoute={() => undefined} />);

    expect(screen.getByRole("heading", { name: "Exact matches" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Near misses" })).toBeVisible();
    const exactSummary = screen.getByRole("button", { name: /Simple loop/ });
    const nearSummary = screen.getByRole("button", { name: /Lollipop/ });
    expect(exactSummary).toHaveAttribute("aria-expanded", "true");
    expect(nearSummary).toHaveAttribute("aria-expanded", "false");
    expect(exactSummary).toHaveTextContent("5.0 mi");
    expect(screen.getByText("1 of 2 requested exact routes found.")).toBeVisible();

    rerender(<ResultsPanel status="done" response={response()} selectedRouteId="near-lollipop" onSelectRoute={() => undefined} />);
    (screen.getByText("Near misses").closest("details") as HTMLDetailsElement).open = true;
    const detail = screen.getByRole("region", { name: /Skyline Trail.*Lollipop/ });
    fireEvent.click(within(detail).getByText("Route details"));
    expect(within(detail).getByText("Repeated trail")).toBeVisible();
    expect(within(detail).getByText("25%")).toBeVisible();
    expect(within(detail).getByText("Shared stem")).toBeVisible();
    expect(within(detail).getByText("0.2 mi")).toBeVisible();
    expect(within(detail).getByText(/distance: 2.0 mi/)).toBeVisible();
    expect(within(detail).getByText("same trailhead")).toBeVisible();
  });

  it("synchronizes expanded selection and keyboard focus", () => {
    render(<ControlledResultsPanel />);
    const list = screen.getByLabelText("Generated routes");
    fireEvent.keyDown(list, { key: "ArrowDown" });
    const nearSummary = screen.getByRole("button", { name: /Lollipop/ });
    expect(nearSummary).toHaveFocus();
    expect(nearSummary).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(list, { key: "Home" });
    expect(screen.getByRole("button", { name: /Simple loop/ })).toHaveFocus();
  });

  it("shows and copies trailhead coordinates", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<ResultsPanel status="done" response={response()} selectedRouteId="exact-loop" onSelectRoute={() => undefined} />);
    await userEvent.click(screen.getByRole("button", { name: "Copy trailhead coordinates 37.15000, -122.18000" }));
    expect(writeText).toHaveBeenCalledWith("37.15000, -122.18000");
  });

  it("previews a route trace without changing selection", () => {
    const previews: Array<string | undefined> = [];
    const handlePreview = (event: Event) => previews.push((event as CustomEvent<{ routeId?: string }>).detail.routeId);
    window.addEventListener(ROUTE_PREVIEW_EVENT, handlePreview);
    render(<ResultsPanel status="done" response={response()} selectedRouteId="exact-loop" onSelectRoute={() => undefined} />);
    const card = screen.getByRole("article", { name: /Ridge Trail.*Simple loop/ });
    fireEvent.mouseEnter(card);
    fireEvent.mouseLeave(card);
    expect(previews).toEqual(["exact-loop", undefined]);
    window.removeEventListener(ROUTE_PREVIEW_EVENT, handlePreview);
  });

  it("reports budget truncation and non-budget shortfall honestly", async () => {
    render(<ResultsPanel
      status="done"
      response={response({
        requested: 10,
        exact: [],
        nearMisses: [],
        diagnostics: {
          elapsedMs: 3000,
          expandedStates: 100000,
          exhausted: false,
          hardTruncationReasons: ["deadline"],
          nonBudgetShortfallReasons: ["no-feasible-cycle-access-points"],
        },
      })}
      onSelectRoute={() => undefined}
    />);
    expect(screen.getByText("0 of 10 requested exact routes found.")).toBeVisible();
    expect(screen.getByText(/effort limit stopped the search early/)).toBeVisible();
    await userEvent.click(screen.getByText("Search diagnostics"));
    const diagnostics = screen.getByText("Search diagnostics").closest("details") as HTMLElement;
    expect(within(diagnostics).getByText(/Hard search limits:/).closest("p")).toHaveTextContent("deadline");
    expect(within(diagnostics).getByText(/Shortfall:/).closest("p")).toHaveTextContent("no-feasible-cycle-access-points");
  });

  it("does not call a complete exact set partial", () => {
    render(<ResultsPanel
      status="done"
      response={response({ requested: 1, exact: [route()], nearMisses: [], diagnostics: { hardTruncationReasons: ["deadline"] } })}
      onSelectRoute={() => undefined}
    />);
    expect(screen.queryByText(/requested exact routes found/)).not.toBeInTheDocument();
  });

  it("announces loading, error, and cancelled states", () => {
    const { rerender } = render(<ResultsPanel status="loading" response={null} onSelectRoute={() => undefined} />);
    expect(screen.getByRole("status")).toHaveTextContent("generating routes");
    rerender(<ResultsPanel status="error" response={null} message="Fixture pack is unavailable." onSelectRoute={() => undefined} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Fixture pack is unavailable.");
    rerender(<ResultsPanel status="cancelled" response={null} onSelectRoute={() => undefined} />);
    expect(screen.getByRole("status")).toHaveTextContent("No routes were changed");
  });
});
