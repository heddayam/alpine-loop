// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HikeBuilder } from "./HikeBuilder";

vi.mock("../map/HikeMap", () => ({
  HikeMap: ({ onBoundsChange, routes = [], selectedRouteId, onRouteSelect }: {
    onBoundsChange: (bounds: [number, number, number, number] | null) => void;
    routes?: Array<{ id: string }>;
    selectedRouteId?: string;
    onRouteSelect?: (id: string) => void;
  }) => (
    <div aria-label="Mock map">
      <button type="button" onClick={() => onBoundsChange([-122.18, 37.15, -122.13, 37.18])}>Draw fixture boundary</button>
      <button type="button" onClick={() => onBoundsChange([-122.12, 37.1, -122.11, 37.11])}>Draw empty boundary</button>
      <button type="button" onClick={() => onBoundsChange(null)}>Clear fixture boundary</button>
      <output aria-label="Map route state">{routes.map((route) => route.id).join(",")}|selected:{selectedRouteId ?? "none"}</output>
      {routes[1] ? <button type="button" onClick={() => onRouteSelect?.(routes[1]!.id)}>Select second map route</button> : null}
    </div>
  ),
}));

const accessPoint = {
  id: "trailhead-a",
  name: "Fixture Trailhead",
  lon: -122.16,
  lat: 37.16,
  kind: "trailhead",
  accessState: "public",
  confidence: "high",
};

const routeResponse = {
  version: 1,
  requestId: "request-1",
  pack: { id: "fixture-pack", schemaVersion: "1", dataVersion: "fixture-1", builtAt: "2026-08-04T00:00:00Z" },
  requested: 10,
  exact: [],
  nearMisses: [],
  diagnostics: { elapsedMs: 1, expandedStates: 1, candidateCount: 0, exhausted: false, truncationReasons: [] },
};

const generatedRoute = {
  id: "exact-loop",
  shape: "loop",
  geometry: { type: "LineString", coordinates: [[-122.18, 37.15], [-122.16, 37.17], [-122.18, 37.15]] },
  startAccessPoint: { id: "trailhead-a", name: "Fixture Trailhead", lon: -122.16, lat: 37.16, accessState: "public", confidence: "high" },
  endAccessPoint: { id: "trailhead-a", name: "Fixture Trailhead", lon: -122.16, lat: 37.16, accessState: "public", confidence: "high" },
  distanceMeters: 6400,
  elevationGainMeters: 300,
  elevationLossMeters: 300,
  minimumElevationMeters: 300,
  maximumElevationMeters: 600,
  steepestSustainedGradePct: 9,
  repeatedEdgeFraction: 0,
  trailNames: ["Fixture Ridge"],
  warnings: [],
  source: { freshness: "2026-08-01T00:00:00Z", confidence: "high", sourceIds: ["fixture"] },
};

const populatedRouteResponse = {
  ...routeResponse,
  requested: 2,
  exact: [generatedRoute],
  nearMisses: [{
    ...generatedRoute,
    id: "near-route",
    shape: "out-and-back",
    violations: [{ constraint: "distance", value: 2.5, min: 3, max: 8, delta: 0.5, normalizedDelta: 0.1 }],
  }],
  diagnostics: { elapsedMs: 20, expandedStates: 100, candidateCount: 2, exhausted: false, truncationReasons: [] },
};

describe("HikeBuilder", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(cleanup);

  it("exposes compact console, range-row, and sticky action styling hooks", () => {
    const { container } = render(<HikeBuilder />);

    expect(container.querySelector(".builder-console-heading")).toHaveTextContent("Build your route");
    expect(container.querySelector(".step-number")).not.toBeInTheDocument();
    expect(container.querySelectorAll(".dense-shape-grid .shape-option")).toHaveLength(4);
    expect(container.querySelectorAll(".range-table .range-table-row")).toHaveLength(4);
    expect(container.querySelector(".builder-action-footer")).toContainElement(
      screen.getByRole("button", { name: "Generate routes" }),
    );
  });

  it("announces the pre-draw empty state and validates generation without a boundary", async () => {
    render(<HikeBuilder />);
    expect(screen.getByText("Draw a boundary to find access points.")).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Explore results" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Results" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Generate routes" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Draw a search rectangle on the map first.");
  });

  it("renders accepted routes on the map and synchronizes card and map selection", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ accessPoints: [accessPoint] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(populatedRouteResponse), { status: 200 }));
    render(<HikeBuilder />);

    await userEvent.click(screen.getByRole("button", { name: "Draw fixture boundary" }));
    await screen.findByLabelText("Access point");
    await userEvent.click(screen.getByRole("button", { name: "Generate routes" }));
    await screen.findByRole("heading", { name: "Explore results" });

    expect(screen.getByLabelText("Map route state")).toHaveTextContent("exact-loop,near-route|selected:exact-loop");
    await userEvent.click(screen.getByRole("button", { name: "Select second map route" }));
    expect(screen.getByLabelText("Map route state")).toHaveTextContent("selected:near-route");
    expect(screen.getByRole("button", { name: /Out & back/ })).toHaveAttribute("aria-pressed", "true");

    await userEvent.click(screen.getByRole("button", { name: /Loop/ }));
    expect(screen.getByLabelText("Map route state")).toHaveTextContent("selected:exact-loop");
  });

  it("cancels an in-flight route request and announces the cancelled state", async () => {
    let generationSignal: AbortSignal | undefined;
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ accessPoints: [accessPoint] }), { status: 200 }))
      .mockImplementationOnce((_input, init) => {
        generationSignal = init?.signal ?? undefined;
        return new Promise((_resolve, reject) => {
          generationSignal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        });
      });
    render(<HikeBuilder />);

    await userEvent.click(screen.getByRole("button", { name: "Draw fixture boundary" }));
    await screen.findByLabelText("Access point");
    await userEvent.click(screen.getByRole("button", { name: "Generate routes" }));
    expect(screen.getByRole("button", { name: "Cancel generation" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Cancel generation" }));

    expect(generationSignal?.aborted).toBe(true);
    expect(await screen.findByRole("heading", { name: "Search cancelled" })).toBeVisible();
    expect(screen.getByText("Route generation was cancelled.")).toHaveAttribute("role", "status");
  });

  it("loads fixture access points, lets one be selected, and sends the accepted request contract", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ accessPoints: [accessPoint] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(routeResponse), { status: 200 }));
    render(<HikeBuilder />);

    await userEvent.click(screen.getByRole("button", { name: "Draw fixture boundary" }));
    const select = await screen.findByLabelText("Access point");
    await userEvent.selectOptions(select, "trailhead-a");
    expect(screen.getByRole("spinbutton", { name: "Number of routes" })).toHaveValue(10);
    expect(screen.getByRole("switch", { name: /Include uncertain access/ })).toBeChecked();

    await userEvent.click(screen.getByRole("button", { name: "Generate routes" }));
    await screen.findByText("No exact matches. 0 near matches are available.");
    const init = fetchMock.mock.calls[1]?.[1];
    const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(request).toMatchObject({
      version: 1,
      packId: "fixture-pack",
      bbox: [-122.18, 37.15, -122.13, 37.18],
      startAccessPointId: "trailhead-a",
      routeTypes: ["out-and-back"],
      distanceMiles: { min: 1, max: 4 },
      includeUncertainAccess: true,
      limit: 10,
    });
  });

  it("announces loading and the no-access-points state", async () => {
    let resolveFetch!: (response: Response) => void;
    vi.spyOn(globalThis, "fetch").mockReturnValue(new Promise((resolve) => { resolveFetch = resolve; }));
    render(<HikeBuilder />);
    fireEvent.click(screen.getByRole("button", { name: "Draw empty boundary" }));
    expect(screen.getByText("Loading access points…")).toHaveAttribute("role", "status");
    resolveFetch(new Response(JSON.stringify({ accessPoints: [] }), { status: 200 }));
    await waitFor(() => expect(screen.getByText("No known access points are inside this boundary.")).toHaveAttribute("role", "status"));
  });

  it("shows the actionable server message when map context is too large", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      error: "Boundary contains too many mapped trail segments; draw a smaller rectangle",
    }), { status: 422 }));
    render(<HikeBuilder />);

    await userEvent.click(screen.getByRole("button", { name: "Draw fixture boundary" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Boundary contains too many mapped trail segments; draw a smaller rectangle",
    );
  });

  it("clears an access selection when the hard boundary is cleared", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ accessPoints: [accessPoint] }), { status: 200 }));
    render(<HikeBuilder />);
    await userEvent.click(screen.getByRole("button", { name: "Draw fixture boundary" }));
    await userEvent.selectOptions(await screen.findByLabelText("Access point"), "trailhead-a");
    await userEvent.click(screen.getByRole("button", { name: "Clear fixture boundary" }));
    expect(screen.queryByLabelText("Access point")).not.toBeInTheDocument();
    expect(screen.getByText("No boundary drawn")).toBeVisible();
  });
});
