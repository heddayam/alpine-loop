// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HikeBuilder } from "./HikeBuilder";

vi.mock("../map/HikeMap", () => ({
  HikeMap: ({ onBoundsChange }: { onBoundsChange: (bounds: [number, number, number, number] | null) => void }) => (
    <div aria-label="Mock map">
      <button type="button" onClick={() => onBoundsChange([-122.18, 37.15, -122.13, 37.18])}>Draw fixture boundary</button>
      <button type="button" onClick={() => onBoundsChange([-122.12, 37.1, -122.11, 37.11])}>Draw empty boundary</button>
      <button type="button" onClick={() => onBoundsChange(null)}>Clear fixture boundary</button>
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

describe("HikeBuilder", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(cleanup);

  it("announces the pre-draw empty state and validates generation without a boundary", async () => {
    render(<HikeBuilder />);
    expect(screen.getByText("Draw a boundary to find access points.")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Generate routes" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Draw a search rectangle on the map first.");
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
    expect(screen.getByRole("switch", { name: /Include uncertain access/ })).not.toBeChecked();

    await userEvent.click(screen.getByRole("button", { name: "Generate routes" }));
    await screen.findByText("No exact matches. 0 near matches are available.");
    const init = fetchMock.mock.calls[1]?.[1];
    const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(request).toMatchObject({
      version: 1,
      packId: "fixture-pack",
      bbox: [-122.18, 37.15, -122.13, 37.18],
      startAccessPointId: "trailhead-a",
      routeTypes: ["loop"],
      distanceMiles: { min: 3, max: 8 },
      includeUncertainAccess: false,
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
