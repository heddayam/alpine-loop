// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GeneratedClosedRouteV3, GenerateClosedRoutesResponseV3 } from "@/lib/contracts";
import { ResultsPanel } from "./ResultsPanel";
import type { RouteResults } from "./types";

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
    trailSegments: [{
      id: "exact-loop:segment:1",
      geometry: { type: "LineString", coordinates: [[-122.18, 37.15], [-122.16, 37.17]] },
      name: "Ridge Trail",
      distanceMeters: 965.6064,
      startDistanceMeters: 0,
      endDistanceMeters: 965.6064,
      accessState: "public",
      condition: { highway: "path", surface: "dirt", trailVisibility: "good" },
      sourceFeatureId: "way/101",
      sourceIds: ["osm"],
    }, {
      id: "exact-loop:segment:2",
      geometry: { type: "LineString", coordinates: [[-122.16, 37.17], [-122.18, 37.15]] },
      name: null,
      distanceMeters: 7081.1136,
      startDistanceMeters: 965.6064,
      endDistanceMeters: 8046.72,
      accessState: "unknown",
      condition: { highway: "path" },
      sourceFeatureId: "way/102",
      sourceIds: ["osm"],
    }],
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

type ResultsOverrides = Partial<Pick<GenerateClosedRoutesResponseV3, "requested" | "exact" | "nearMisses">> & {
  diagnostics?: Partial<GenerateClosedRoutesResponseV3["diagnostics"]>;
};

function results(overrides: ResultsOverrides = {}): Extract<RouteResults, { kind: "quick" }> {
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
  const exact = overrides.exact ?? [route()];
  const nearMisses: GenerateClosedRoutesResponseV3["nearMisses"] = overrides.nearMisses ?? [{
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
  }];
  return {
    kind: "quick",
    requested: overrides.requested ?? 2,
    exact: exact.map((route) => ({ ...route, regionLabel: "Santa Cruz Mountains" })),
    nearMisses: nearMisses.map((route) => ({ ...route, regionLabel: "Santa Cruz Mountains" })),
    searches: [{
      label: "Santa Cruz Mountains",
      requestId: "request-results-1",
      pack: { id: "fixture-pack", schemaVersion: "3", dataVersion: "fixture-3", builtAt: "2026-08-01T00:00:00Z" },
      resolvedAccessFilter: { mode: "drawn-area", label: "Drawn area" },
      diagnostics,
    }],
  };
}

function ControlledResultsPanel() {
  const [selectedRouteId, setSelectedRouteId] = useState("exact-loop");
  return <ResultsPanel onHoverRoute={() => undefined} status="done" results={results()} selectedRouteId={selectedRouteId} onSelectRoute={setSelectedRouteId} />;
}

describe("ResultsPanel", () => {
  afterEach(cleanup);

  it("separates exact matches from labeled close matches and renders closed topology", () => {
    const { rerender } = render(<ResultsPanel onHoverRoute={() => undefined} status="done" results={results()} selectedRouteId="exact-loop" onSelectRoute={() => undefined} />);

    expect(screen.getByRole("heading", { name: "Exact matches" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Close matches" })).toBeVisible();
    const exactSection = screen.getByRole("heading", { name: "Exact matches" }).closest("section") as HTMLElement;
    const nearSection = screen.getByRole("heading", { name: "Close matches" }).closest("details") as HTMLElement;
    const exactSummary = within(exactSection).getByRole("button", { name: /Saratoga Gap.*Ridge Trail/ });
    const nearSummary = within(nearSection).getByRole("button", { name: /Saratoga Gap.*Ridge Trail/ });
    expect(exactSummary).toHaveAttribute("aria-expanded", "true");
    expect(nearSummary).toHaveAttribute("aria-expanded", "false");
    expect(exactSummary).toHaveTextContent("5.0 mi");
    expect(exactSummary).not.toHaveTextContent("Simple loop");
    expect(screen.getByRole("img", { name: /Elevation profile/ })).toHaveAttribute("preserveAspectRatio", "none");
    expect(screen.getByText("1 of 2 requested exact routes found.")).toBeVisible();

    rerender(<ResultsPanel onHoverRoute={() => undefined} status="done" results={results()} selectedRouteId="near-lollipop" onSelectRoute={() => undefined} />);
    (screen.getByText("Close matches").closest("details") as HTMLDetailsElement).open = true;
    const detail = screen.getByRole("region", { name: /Saratoga Gap.*Ridge Trail/ });
    fireEvent.click(within(detail).getByText("Details"));
    expect(within(detail).getByText("Route shape")).toBeVisible();
    expect(within(detail).getByText("Lollipop")).toBeVisible();
    expect(within(detail).getByText("Repeated trail")).toBeVisible();
    expect(within(detail).getByText("25%")).toBeVisible();
    expect(within(detail).getByText("Shared stem")).toBeVisible();
    expect(within(detail).getByText("0.2 mi")).toBeVisible();
    expect(within(nearSummary).getByTitle("Distance")).toHaveClass("near-match-stat");
    expect(within(detail).queryByText(/Outside requested constraints/)).not.toBeInTheDocument();
    expect(within(detail).queryByText("same trailhead")).not.toBeInTheDocument();
  });

  it("synchronizes expanded selection and keyboard focus", () => {
    render(<ControlledResultsPanel />);
    const list = screen.getByLabelText("Generated routes");
    fireEvent.keyDown(list, { key: "ArrowDown" });
    const nearSection = screen.getByRole("heading", { name: "Close matches" }).closest("details") as HTMLElement;
    const nearSummary = within(nearSection).getByRole("button", { name: /Saratoga Gap.*Ridge Trail/ });
    expect(nearSummary).toHaveFocus();
    expect(nearSummary).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(list, { key: "Home" });
    const exactSection = screen.getByRole("heading", { name: "Exact matches" }).closest("section") as HTMLElement;
    expect(within(exactSection).getByRole("button", { name: /Saratoga Gap.*Ridge Trail/ })).toHaveFocus();
  });

  it("marks only violated close-match metrics in orange without a warning block", () => {
    const closeMatch = {
      ...route({
        id: "close-metrics",
        gradeExperience: { climbP90Pct: 16, steepClimbingSharePct: 30, longestSteepClimbMeters: 400, descentP90Pct: 17, windowMeters: 100 as const, steepThresholdPct: 10 as const },
        topology: {
          kind: "lollipop" as const,
          cycleCount: 1,
          cycleBlockCount: 1,
          repeatedTrailDistanceMeters: 1600,
          repeatedTrailFraction: 0.2,
          sharedStemDistanceMeters: 800,
          connectorCount: 1,
        },
      }),
      violations: [
        { constraint: "elevation-gain" as const, value: 365, min: 0, max: 300, delta: 65, normalizedDelta: 0.2 },
        { constraint: "maximum-elevation" as const, value: 792, min: 0, max: 700, delta: 92, normalizedDelta: 0.1 },
        { constraint: "climb-p90-grade" as const, value: 16, min: 0, max: 12, delta: 4, normalizedDelta: 0.3 },
        { constraint: "repeated-trail" as const, value: 20, min: 0, max: 15, delta: 5, normalizedDelta: 0.3 },
        { constraint: "shared-stem" as const, value: 800, min: 0, max: 400, delta: 400, normalizedDelta: 1 },
      ],
    };
    render(<ResultsPanel onHoverRoute={() => undefined}
      status="done"
      results={results({ exact: [], nearMisses: [closeMatch] })}
      selectedRouteId="close-metrics"
      nearMissesOpen
      onSelectRoute={() => undefined}
    />);

    const summary = screen.getByRole("button", { name: /Saratoga Gap.*Ridge Trail/ });
    expect(within(summary).getByTitle("Elevation gain")).toHaveClass("near-match-stat");
    expect(within(summary).getByTitle("Distance")).not.toHaveClass("near-match-stat");
    expect(within(summary).getByTitle(/90% of uphill/)).toHaveClass("near-match-stat");
    fireEvent.click(screen.getByText("Details"));
    expect(screen.getByText("High point").nextElementSibling).toHaveClass("near-match-stat");
    expect(screen.getByText("Repeated trail").nextElementSibling).toHaveClass("near-match-stat");
    expect(screen.getByText("Shared stem").nextElementSibling).toHaveClass("near-match-stat");
    expect(screen.queryByText(/Outside requested constraints/)).not.toBeInTheDocument();
  });

  it("shows and copies trailhead coordinates", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<ResultsPanel onHoverRoute={() => undefined} status="done" results={results()} selectedRouteId="exact-loop" onSelectRoute={() => undefined} />);
    await userEvent.click(screen.getByRole("button", { name: "Copy trailhead coordinates 37.15000, -122.18000" }));
    expect(writeText).toHaveBeenCalledWith("37.15000, -122.18000");
    expect(screen.getByText("Trailhead")).toBeVisible();
    expect(await screen.findByText("Copied")).toBeVisible();
    expect(screen.queryByText("37.15000, -122.18000", { selector: "code" })).not.toBeInTheDocument();
    expect(screen.getByText("Trailhead coordinates copied")).toHaveClass("visually-hidden");
  });

  it("reports when trailhead coordinates could not be copied", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("Clipboard denied"));
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<ResultsPanel onHoverRoute={() => undefined} status="done" results={results()} selectedRouteId="exact-loop" onSelectRoute={() => undefined} />);
    await userEvent.click(screen.getByRole("button", { name: "Copy trailhead coordinates 37.15000, -122.18000" }));
    expect(screen.getByText("Trailhead")).toBeVisible();
    expect(await screen.findByText("Couldn’t copy")).toBeVisible();
    expect(screen.queryByText("37.15000, -122.18000", { selector: "code" })).not.toBeInTheDocument();
    expect(screen.getByText("Trailhead coordinates could not be copied")).toHaveClass("visually-hidden");
  });

  it("synchronizes segment hover and selection with the map-facing callbacks", async () => {
    const onHoverSegment = vi.fn();
    const onSelectSegment = vi.fn();
    const { rerender } = render(<ResultsPanel onHoverRoute={() => undefined}
      status="done"
      results={results()}
      selectedRouteId="exact-loop"
      onSelectRoute={() => undefined}
      onHoverSegment={onHoverSegment}
      onSelectSegment={onSelectSegment}
    />);
    const ridge = screen.getByRole("button", { name: /0.6 mi.*Ridge Trail/i });
    const namedSearch = screen.getByRole("link", { name: "Search Google for Ridge Trail conditions" });
    const unnamedSearch = screen.getByRole("link", { name: "Search Google for conditions near this unnamed trail segment" });
    expect(screen.queryByText("dirt")).not.toBeInTheDocument();
    expect(screen.queryByText("Untagged")).not.toBeInTheDocument();
    expect(namedSearch).toHaveAttribute("href", "https://www.google.com/search?q=Ridge%20Trail%20conditions");
    expect(namedSearch).toHaveAttribute("target", "_blank");
    expect(namedSearch).toHaveAttribute("rel", "noopener noreferrer");
    expect(unnamedSearch).toHaveAttribute("href", "https://www.google.com/search?q=trail%20conditions%20near%2037.17000%2C%20-122.16000");

    await userEvent.hover(ridge);
    expect(onHoverSegment).toHaveBeenLastCalledWith("exact-loop:segment:1");
    await userEvent.click(ridge);
    expect(onSelectSegment).toHaveBeenCalledWith("exact-loop:segment:1");
    namedSearch.focus();
    expect(onHoverSegment).toHaveBeenLastCalledWith("exact-loop:segment:1");

    rerender(<ResultsPanel onHoverRoute={() => undefined}
      status="done"
      results={results()}
      selectedRouteId="exact-loop"
      hoveredSegmentId="exact-loop:segment:1"
      onSelectRoute={() => undefined}
      onHoverSegment={onHoverSegment}
      onSelectSegment={onSelectSegment}
    />);
    expect(screen.getByRole("button", { name: /0.6 mi.*Ridge Trail/i })).toHaveClass("hovered");
  });

  it("explains grade experience with whole-number percentages", () => {
    render(<ResultsPanel onHoverRoute={() => undefined} status="done" results={results({
      exact: [route({ gradeExperience: { climbP90Pct: 11.34, steepClimbingSharePct: 18.73, longestSteepClimbMeters: 275, descentP90Pct: 14.13, windowMeters: 100, steepThresholdPct: 10 } })],
      nearMisses: [],
    })} onSelectRoute={() => undefined} />);
    const summary = screen.getByRole("button", { name: /Saratoga Gap.*Ridge Trail/ });
    expect(summary).toHaveTextContent(/↑P90 11%≥10% 19%/);
    expect(summary).not.toHaveTextContent("mi run");
    expect(within(summary).getByTitle(/90% of uphill 100 m sections are 11% grade or less/)).toBeVisible();
  });

  it("previews through callbacks on pointer and focus, and clears a removed view", () => {
    const onHoverRoute = vi.fn();
    const onSelectRoute = vi.fn();
    const { unmount } = render(<ResultsPanel onHoverRoute={onHoverRoute} status="done" results={results()} selectedRouteId="exact-loop" onSelectRoute={onSelectRoute} />);
    const exactSection = screen.getByRole("heading", { name: "Exact matches" }).closest("section") as HTMLElement;
    const card = within(exactSection).getByRole("article", { name: /Saratoga Gap.*Ridge Trail/ });
    fireEvent.mouseEnter(card);
    expect(onHoverRoute).toHaveBeenLastCalledWith("exact-loop");
    fireEvent.mouseLeave(card);
    expect(onHoverRoute).toHaveBeenLastCalledWith(undefined);
    const buttons = within(card).getAllByRole("button");
    fireEvent.focus(buttons[0]!);
    expect(onHoverRoute).toHaveBeenLastCalledWith("exact-loop");
    const callsBeforeInternalBlur = onHoverRoute.mock.calls.length;
    fireEvent.blur(buttons[0]!, { relatedTarget: buttons[1] });
    expect(onHoverRoute).toHaveBeenCalledTimes(callsBeforeInternalBlur);
    fireEvent.blur(buttons[1]!, { relatedTarget: document.body });
    expect(onHoverRoute).toHaveBeenLastCalledWith(undefined);
    fireEvent.mouseEnter(card);
    unmount();
    expect(onHoverRoute).toHaveBeenLastCalledWith(undefined);
    expect(onSelectRoute).not.toHaveBeenCalled();
  });

  it("reports budget truncation and non-budget shortfall honestly", async () => {
    render(<ResultsPanel onHoverRoute={() => undefined}
      status="done"
      results={results({
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
    expect(screen.getByText(/Close matches are listed separately/)).toBeVisible();
    await userEvent.click(screen.getByText("Diagnostics"));
    const diagnostics = screen.getByText("Diagnostics").closest("details") as HTMLElement;
    expect(within(diagnostics).getByText(/Hard search limits:/).closest("p")).toHaveTextContent("deadline");
    expect(within(diagnostics).getByText(/Shortfall:/).closest("p")).toHaveTextContent("no-feasible-cycle-access-points");
  });

  it("does not call a complete exact set partial", () => {
    render(<ResultsPanel onHoverRoute={() => undefined}
      status="done"
      results={results({ requested: 1, exact: [route()], nearMisses: [], diagnostics: { hardTruncationReasons: ["deadline"] } })}
      onSelectRoute={() => undefined}
    />);
    expect(screen.queryByText(/requested exact routes found/)).not.toBeInTheDocument();
  });

  it("shows saved job progress without a fabricated route target or solver counters", async () => {
    const saved: RouteResults = {
      kind: "saved",
      exact: [],
      nearMisses: results().nearMisses,
      job: {
        version: 1,
        id: "3d594650-3436-4f8b-a0e8-38d13fc148ca",
        status: "cancelled",
        request: {
          version: 1,
          packId: "fixture-pack",
          searchRegionId: "region-1",
          criteria: {
            closedRoute: { maximumRepeatedTrailPct: 35, allowMultiCycle: true },
            distanceMiles: { min: 3, max: 8 },
            includeUncertainAccess: true,
          },
          routesPerAccessPoint: 10,
        },
        pack: { id: "fixture-pack", dataVersion: "fixture-v4", builtAt: "2026-08-04T00:00:00Z" },
        searchRegion: { id: "region-1", name: "Santa Cruz Mountains" },
        progress: { eligibleAccessPointCount: 10, processedAccessPointCount: 4, exactRouteCount: 8, nearMissRouteCount: 2, truncatedAccessPointCount: 1, elapsedMs: 12_000 },
        partial: true,
        stale: true,
        createdAt: "2026-08-06T00:00:00Z",
        updatedAt: "2026-08-06T00:00:12Z",
      },
    };
    render(<ResultsPanel onHoverRoute={() => undefined} status="done" results={saved} onSelectRoute={() => undefined} />);
    expect(screen.getByText("Full search cancelled.")).toBeVisible();
    expect(screen.getByText("4 of 10 trailheads attempted.")).toBeVisible();
    expect(screen.getByText("Partial results retained.")).toBeVisible();
    expect(screen.getByText("Built with an older pack version.")).toBeVisible();
    expect(screen.getByText(/1 trailhead search.*reached/)).toBeVisible();
    expect(screen.queryByText(/requested exact routes found/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByText("Diagnostics"));
    expect(screen.getByText("Saved exact routes").nextElementSibling).toHaveTextContent("8");
    expect(screen.getByText("Saved close matches").nextElementSibling).toHaveTextContent("2");
    expect(screen.getByText("Elapsed").nextElementSibling).toHaveTextContent("12,000 ms");
    expect(screen.queryByText("States explored")).not.toBeInTheDocument();
    expect(screen.queryByText("Graph queries")).not.toBeInTheDocument();
  });

  it("keeps each Quick search's diagnostics and identity separate", async () => {
    const combined = results({ requested: 2 });
    const first = combined.searches[0]!;
    combined.searches.push({
      ...first,
      label: "East Bay",
      requestId: "request-east-bay",
      pack: { ...first.pack, id: "east-bay" },
      diagnostics: { ...first.diagnostics, elapsedMs: 71, expandedStates: 300 },
    });
    render(<ResultsPanel onHoverRoute={() => undefined} status="done" results={combined} onSelectRoute={() => undefined} />);
    expect(screen.getByText("1 of 2 requested exact routes found.")).toBeVisible();
    await userEvent.click(screen.getByText("Diagnostics"));
    const west = within(screen.getByRole("region", { name: "Santa Cruz Mountains" }));
    const east = within(screen.getByRole("region", { name: "East Bay" }));
    expect(west.getByText("Elapsed").nextElementSibling).toHaveTextContent("42 ms");
    expect(east.getByText("Elapsed").nextElementSibling).toHaveTextContent("71 ms");
    expect(west.getByText("States explored").nextElementSibling).toHaveTextContent("1,200");
    expect(east.getByText("States explored").nextElementSibling).toHaveTextContent("300");
    expect(east.getByText("Request ID").nextElementSibling).toHaveTextContent("request-east-bay");
  });

  it("announces loading, error, and cancelled states", () => {
    const { rerender } = render(<ResultsPanel onHoverRoute={() => undefined} status="loading" results={null} onSelectRoute={() => undefined} />);
    expect(screen.getByRole("status")).toHaveTextContent("generating routes");
    rerender(<ResultsPanel onHoverRoute={() => undefined} status="error" results={null} message="Fixture pack is unavailable." onSelectRoute={() => undefined} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Fixture pack is unavailable.");
    rerender(<ResultsPanel onHoverRoute={() => undefined} status="cancelled" results={null} onSelectRoute={() => undefined} />);
    expect(screen.getByRole("status")).toHaveTextContent("No routes were changed");
  });
});
