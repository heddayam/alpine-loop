// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

const baseProps = {
  open: true,
  loadState: "ready" as const,
  refreshedAt: Date.parse("2026-08-06T00:00:12Z"),
  onClose: vi.fn(),
  onRefresh: vi.fn(async () => undefined),
  onOpenResults: vi.fn(),
};

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("JobsModal", () => {
  it("shows a human stage and attempted-count progress", () => {
    render(<JobsModal {...baseProps} jobs={[job]} />);
    expect(screen.getByText("Searching trailheads — 4 of 10 attempted.")).toBeVisible();
    expect(screen.getByRole("progressbar", { name: "4 of 10 trailheads attempted" })).toHaveAttribute("value", "40");

    const queued = { ...job, status: "queued" as const, progress: { ...job.progress, eligibleAccessPointCount: 0, processedAccessPointCount: 0 } };
    cleanup();
    render(<JobsModal {...baseProps} jobs={[queued]} />);
    expect(screen.getByRole("progressbar", { name: "Preparing trailhead search" })).not.toHaveAttribute("value");
  });

  it("advances elapsed presentation time locally and freezes terminal jobs", () => {
    vi.useFakeTimers();
    const refreshedAt = Date.parse("2026-08-06T00:00:12Z");
    vi.setSystemTime(refreshedAt);
    const view = render(<JobsModal {...baseProps} refreshedAt={refreshedAt} jobs={[job]} />);
    expect(screen.getByText("12s")).toBeVisible();
    act(() => { vi.advanceTimersByTime(3_000); });
    expect(screen.getByText("15s")).toBeVisible();

    const completed = { ...job, status: "completed" as const, progress: { ...job.progress, elapsedMs: 15_000 }, completedAt: "2026-08-06T00:00:15Z" };
    view.rerender(<JobsModal {...baseProps} refreshedAt={Date.now()} jobs={[completed]} />);
    act(() => { vi.advanceTimersByTime(3_000); });
    expect(screen.getByText("15s")).toBeVisible();
    expect(screen.queryByText("18s")).not.toBeInTheDocument();
  });

  it("keeps cancellation feedback until polling confirms the terminal state", async () => {
    const onRefresh = vi.fn(async () => undefined);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(job), { status: 200 }));
    const view = render(<JobsModal {...baseProps} jobs={[job]} onRefresh={onRefresh} />);
    await userEvent.click(screen.getByRole("button", { name: "Cancel Santa Cruz Mountains search" }));
    expect(screen.getByRole("button", { name: "Cancelling…" })).toBeDisabled();
    expect(screen.getByText(/Stopping after the current trailhead/)).toBeVisible();
    expect(onRefresh).toHaveBeenCalledWith(true);

    const cancelled = { ...job, status: "cancelled" as const, partial: true, completedAt: "2026-08-06T00:00:15Z" };
    view.rerender(<JobsModal {...baseProps} jobs={[cancelled]} onRefresh={onRefresh} />);
    expect(screen.getByText("Partial results retained.")).toBeVisible();
    expect(screen.getByText("Stopped after 4 of 10 trailheads.")).toBeVisible();
    expect(screen.getByRole("button", { name: "View results for Santa Cruz Mountains" })).toBeVisible();
  });

  it("keeps an active deletion visible until refresh omits it", async () => {
    const onRefresh = vi.fn(async () => undefined);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    const view = render(<JobsModal {...baseProps} jobs={[job]} onRefresh={onRefresh} />);
    await userEvent.click(screen.getByRole("button", { name: "Delete Santa Cruz Mountains job and saved routes" }));
    expect(screen.getByText("Removing this job and its saved routes.")).toBeVisible();
    expect(screen.getByText("Santa Cruz Mountains")).toBeVisible();

    view.rerender(<JobsModal {...baseProps} jobs={[{ ...job, status: "deleting" }]} onRefresh={onRefresh} />);
    expect(screen.getByText("Santa Cruz Mountains")).toBeVisible();
    view.rerender(<JobsModal {...baseProps} jobs={[]} onRefresh={onRefresh} />);
    expect(screen.getByText("No batch searches yet.")).toBeVisible();
    expect(screen.queryByText("Santa Cruz Mountains")).not.toBeInTheDocument();
  });

  it("retains saved data during a refresh error and offers retry", async () => {
    const onRefresh = vi.fn(async () => undefined);
    render(<JobsModal {...baseProps} jobs={[job]} loadState="error" loadError="Progress may be out of date." onRefresh={onRefresh} />);
    expect(screen.getByText("Santa Cruz Mountains")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(onRefresh).toHaveBeenCalledWith(true));
  });
});
