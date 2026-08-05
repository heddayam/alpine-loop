// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HikeBuilder } from "./HikeBuilder";

vi.mock("../map/HikeMap", () => ({
  HikeMap: ({ onBoundsChange, mode, routes = [], selectedRouteId }: {
    onBoundsChange: (bounds: [number, number, number, number] | null) => void;
    mode: string;
    routes?: Array<{ id: string }>;
    selectedRouteId?: string;
  }) => <div aria-label="Mock map"><output aria-label="Mock map mode">{mode}</output><button type="button" onClick={() => onBoundsChange([-122.18, 37.15, -122.13, 37.18])}>Draw fixture area</button><button type="button" onClick={() => onBoundsChange(null)}>Clear fixture area</button><output aria-label="Map route state">{routes.map((route) => route.id).join(",")}|selected:{selectedRouteId ?? "none"}</output></div>,
}));

const accessPoint = { id: "trailhead-a", name: "Fixture Trailhead", lon: -122.16, lat: 37.16, kind: "trailhead", accessState: "public", confidence: "high" };
const preview = { resolvedAccessFilter: { mode: "drawn-area", label: "Drawn area" }, filterGeometry: { type: "Polygon", coordinates: [[[-122.18, 37.15], [-122.13, 37.15], [-122.13, 37.18], [-122.18, 37.18], [-122.18, 37.15]]] }, accessPoints: [accessPoint] };
const generatedRoute = {
  id: "exact-route", shape: "out-and-back", geometry: { type: "LineString", coordinates: [[-122.16, 37.16], [-122.12, 37.19], [-122.16, 37.16]] },
  startAccessPoint: { id: "trailhead-a", name: "Fixture Trailhead", lon: -122.16, lat: 37.16, accessState: "public", confidence: "high" },
  endAccessPoint: { id: "trailhead-a", name: "Fixture Trailhead", lon: -122.16, lat: 37.16, accessState: "public", confidence: "high" },
  distanceMeters: 6400, elevationGainMeters: 300, elevationLossMeters: 300, minimumElevationMeters: 300, maximumElevationMeters: 600,
  steepestSustainedGradePct: 9, repeatedEdgeFraction: 0, trailNames: ["Fixture Ridge"], warnings: [],
  source: { freshness: "2026-08-01T00:00:00Z", confidence: "high", sourceIds: ["fixture"] }, filterMatch: { start: true, end: true },
};
const routeResponse = {
  version: 2, requestId: "request-1", pack: { id: "fixture-pack", schemaVersion: "2", dataVersion: "fixture-2", builtAt: "2026-08-04T00:00:00Z" },
  requested: 10, resolvedAccessFilter: { mode: "drawn-area", label: "Drawn area" }, exact: [generatedRoute], nearMisses: [],
  diagnostics: { elapsedMs: 1, expandedStates: 1, candidateCount: 1, eligibleAccessPointCount: 1, searchedAccessPointCount: 1, graphQueryCount: 1, maximumLoadedDirectedEdges: 4, exhausted: false, truncationReasons: [], shortfallReasons: [] },
};

describe("HikeBuilder V2 trailhead filters", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(cleanup);

  it("defaults to Draw area and explains filter semantics", () => {
    render(<HikeBuilder />);
    expect(screen.getByRole("radio", { name: /Draw area/ })).toBeChecked();
    expect(screen.getByText("Highlighted areas filter trailheads, not route geometry.")).toBeVisible();
    expect(screen.getByText("No area drawn yet.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Results" })).toBeDisabled();
  });

  it("previews eligible access and submits the strict V2 drawn-area request", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify(preview), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(routeResponse), { status: 200 }));
    render(<HikeBuilder />);
    await userEvent.click(screen.getByRole("button", { name: "Draw fixture area" }));
    await userEvent.selectOptions(await screen.findByLabelText("Access point"), "trailhead-a");
    await userEvent.click(screen.getByRole("button", { name: "Generate routes" }));
    expect(await screen.findByText("1 exact route ready.")).toBeVisible();
    const request = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as Record<string, unknown>;
    expect(request).toMatchObject({ version: 2, accessFilter: { mode: "drawn-area", bbox: [-122.18, 37.15, -122.13, 37.18] }, startAccessPointId: "trailhead-a", pointToPoint: { finishMustMatchAccessFilter: true }, distanceMiles: { min: 1, max: 4 }, limit: 10 });
    expect(screen.getByLabelText("Map route state")).toHaveTextContent("exact-route|selected:exact-route");
  });

  it("preserves each mode draft while switching and clears stale results", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify(preview), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(routeResponse), { status: 200 }));
    render(<HikeBuilder />);
    await userEvent.click(screen.getByRole("button", { name: "Draw fixture area" }));
    await screen.findByLabelText("Access point");
    await userEvent.click(screen.getByRole("button", { name: "Generate routes" }));
    await screen.findByText("1 exact route ready.");
    await userEvent.click(screen.getByRole("radio", { name: /Named region/ }));
    expect(screen.queryByRole("heading", { name: "Results" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: /Draw area/ }));
    expect(screen.getByText(/-122\.1800, 37\.1500/)).toBeVisible();
  });

  it("requires explicit named-region suggestion selection", async () => {
    const summary = { id: "osm-relation-1", name: "Castle Rock State Park", kind: "park", context: "California", bbox: [-122.2, 37.1, -122.1, 37.2], sourceIds: ["osm"] };
    const area = { ...summary, geometry: { type: "Polygon", coordinates: [[[-122.2, 37.1], [-122.1, 37.1], [-122.1, 37.2], [-122.2, 37.2], [-122.2, 37.1]]] } };
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ areas: [summary] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(area), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...preview, resolvedAccessFilter: { mode: "named-region", label: summary.name }, filterGeometry: area.geometry }), { status: 200 }));
    render(<HikeBuilder />);
    await userEvent.click(screen.getByRole("radio", { name: /Named region/ }));
    await userEvent.type(screen.getByLabelText("Installed named region"), "Castle");
    expect(screen.getByText(/typed names are never converted/i)).toBeVisible();
    const option = await screen.findByRole("option", { name: /Castle Rock State Park/ });
    await userEvent.click(option);
    expect(await screen.findByText("Castle Rock State Park", { selector: ".selection-chip strong" })).toBeVisible();
    expect(await screen.findByLabelText("Access point")).toBeVisible();
  });

  it("supports coordinate origins, 30-minute default, and drive-time calculation", async () => {
    const requestId = "3d594650-3436-4f8b-a0e8-38d13fc148ca";
    const geometry = { type: "Polygon", coordinates: [[[-122.2, 37.1], [-122.1, 37.1], [-122.1, 37.2], [-122.2, 37.2], [-122.2, 37.1]]] };
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "complete", requestId, provider: "arcgis", durationMinutes: 30, resolvedAt: "2026-08-04T00:00:00Z", geometry }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...preview, resolvedAccessFilter: { mode: "drive-time", label: "30 minutes" }, filterGeometry: geometry }), { status: 200 }));
    render(<HikeBuilder />);
    await userEvent.click(screen.getByRole("radio", { name: /Drive time/ }));
    expect(screen.getByLabelText("Typical drive time")).toHaveValue("30");
    await userEvent.type(screen.getByLabelText("Driving origin"), "37.16, -122.16");
    await userEvent.click(screen.getByRole("button", { name: "Use coordinates" }));
    await userEvent.click(screen.getByRole("button", { name: "Calculate drive-time area" }));
    expect(await screen.findByText(/Drive-time area ready/)).toBeVisible();
    expect(await screen.findByLabelText("Access point")).toBeVisible();
    expect(screen.getByText(/live traffic is not used/i)).toBeVisible();
  });

  it("shows the point-to-point finish control on by default and enforces 30 miles", async () => {
    render(<HikeBuilder />);
    await userEvent.click(screen.getByRole("checkbox", { name: /Point to point/ }));
    expect(screen.getByRole("switch", { name: /Keep finish inside trailhead filter/ })).toBeChecked();
    const maximum = screen.getByRole("spinbutton", { name: "Distance maximum" });
    await userEvent.clear(maximum);
    await userEvent.type(maximum, "31");
    await userEvent.click(screen.getByRole("button", { name: "Generate routes" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Route distance may not exceed 30 miles.");
  });

  it("uses browser location only after the user asks and handles denial", async () => {
    const getCurrentPosition = vi.fn((_success, failure: PositionErrorCallback) => failure({ code: 1, message: "denied", PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 }));
    Object.defineProperty(navigator, "geolocation", { configurable: true, value: { getCurrentPosition } });
    render(<HikeBuilder />);
    expect(getCurrentPosition).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("radio", { name: /Drive time/ }));
    await userEvent.click(screen.getByRole("button", { name: "Use my current location" }));
    expect(getCurrentPosition).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("alert")).toHaveTextContent("Location permission was denied");
  });

  it("aborts an in-flight route request when the filter mode changes", async () => {
    let signal: AbortSignal | undefined;
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify(preview), { status: 200 }))
      .mockImplementationOnce((_input, init) => { signal = init?.signal ?? undefined; return new Promise(() => undefined); });
    render(<HikeBuilder />);
    await userEvent.click(screen.getByRole("button", { name: "Draw fixture area" }));
    await screen.findByLabelText("Access point");
    await userEvent.click(screen.getByRole("button", { name: "Generate routes" }));
    await userEvent.click(screen.getByRole("radio", { name: /Named region/ }));
    await waitFor(() => expect(signal?.aborted).toBe(true));
  });
});
