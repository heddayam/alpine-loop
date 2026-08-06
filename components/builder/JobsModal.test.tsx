// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RouteJob } from "@/lib/contracts";
import { JobsModal } from "./JobsModal";

const job: RouteJob = {
  version: 1,
  id: "3d594650-3436-4f8b-a0e8-38d13fc148ca",
  status: "running",
  request: {
    version: 1,
    packId: "fixture-pack",
    origin: { lon: -122.16, lat: 37.16, label: "Castle Rock" },
    durationMinutes: 30,
    searchRegionId: "region-1",
    criteria: {
      closedRoute: { maximumRepeatedTrailPct: 35, allowMultiCycle: true },
      distanceMiles: { min: 3, max: 8 },
      includeUncertainAccess: true,
      accessPointRemoteness: ["remote"],
    },
    routesPerAccessPoint: 10,
  },
  pack: { id: "fixture-pack", dataVersion: "fixture-v4", builtAt: "2026-08-04T00:00:00Z" },
  searchRegion: { id: "region-1", name: "Santa Cruz Mountains" },
  progress: { eligibleAccessPointCount: 10, processedAccessPointCount: 4, exactRouteCount: 8, nearMissRouteCount: 2, truncatedAccessPointCount: 1, elapsedMs: 12_000 },
  partial: false,
  stale: false,
  createdAt: "2026-08-06T00:00:00Z",
  updatedAt: "2026-08-06T00:00:12Z",
};

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("JobsModal", () => {
  it("shows progress and sends cooperative cancellation", async () => {
    const onJobsChange = vi.fn();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input).endsWith("/cancel") && init?.method === "POST") return new Response(JSON.stringify({ job: { ...job, status: "cancelled", partial: true } }), { status: 200 });
      return new Response(JSON.stringify({ version: 1, jobs: [job] }), { status: 200 });
    });
    render(<JobsModal open jobs={[job]} onClose={vi.fn()} onJobsChange={onJobsChange} onOpenResults={vi.fn()} />);
    expect(screen.getByText("4/10")).toBeVisible();
    expect(screen.getByText("12s")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(onJobsChange).toHaveBeenCalledWith([expect.objectContaining({ status: "cancelled", partial: true })]));
  });

  it("removes a job after successful deletion", async () => {
    const onJobsChange = vi.fn();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input).includes(job.id) && init?.method === "DELETE") return new Response(null, { status: 204 });
      return new Response(JSON.stringify({ version: 1, jobs: [job] }), { status: 200 });
    });
    render(<JobsModal open jobs={[job]} onClose={vi.fn()} onJobsChange={onJobsChange} onOpenResults={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(onJobsChange).toHaveBeenCalledWith([]));
  });
});
