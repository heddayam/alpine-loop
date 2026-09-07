// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RouteJobV2 as RouteJob } from "@/lib/contracts/search";
import { JobsModal } from "./JobsModal";

const job: RouteJob = {
  version: 2,
  id: "3d594650-3436-4f8b-a0e8-38d13fc148ca",
  status: "running",
  request: {
    area: { mode: "drive-time", origin: { lon: -122.16, lat: 37.16, label: "Castle Rock" }, durationMinutes: 30, regionIds: ["region-1"] },
    criteria: {
      closedRoute: { maximumRepeatedTrailPct: 35, allowMultiCycle: true },
      distanceMiles: { min: 3, max: 8 },
      includeUncertainAccess: true,
    },
  },
  area: { label: "Santa Cruz Mountains" },
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
  onMutate: vi.fn(),
  pendingByJob: {},
};

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("JobsModal", () => {
  it("shows a human stage and attempted-count progress", () => {
    render(<JobsModal {...baseProps} jobs={[job]} />);
    expect(screen.getByText("Searching trailheads — 4 of 10 attempted.")).toBeVisible();
    expect(screen.getByText("30 min from Castle Rock")).toBeVisible();
    expect(screen.getByRole("progressbar", { name: "4 of 10 trailheads attempted" })).toHaveAttribute("value", "40");

    const queued = { ...job, status: "queued" as const, progress: { ...job.progress, eligibleAccessPointCount: 0, processedAccessPointCount: 0 } };
    cleanup();
    render(<JobsModal {...baseProps} jobs={[queued]} />);
    expect(screen.getByRole("progressbar", { name: "Preparing trailhead search" })).not.toHaveAttribute("value");
  });

  it("labels jobs without an origin as covering the entire reviewed region", () => {
    const regionWide: RouteJob = { ...job, request: { ...job.request, area: { mode: "named-regions", regionIds: ["region-1"] } } };
    render(<JobsModal {...baseProps} jobs={[regionWide]} />);
    expect(screen.getByText("Named regions")).toBeVisible();
    expect(screen.queryByText(/min from/)).not.toBeInTheDocument();
  });

  it("labels drawn-area jobs as using the drawn boundary", () => {
    const drawnArea: RouteJob = {
      ...job,
      request: { ...job.request, area: { mode: "drawn-area", bbox: [-122.2, 37.1, -122.1, 37.2] } },
      area: { label: "Drawn boundary" },
    };
    render(<JobsModal {...baseProps} jobs={[drawnArea]} />);
    expect(screen.getAllByText("Drawn boundary")).toHaveLength(2);
    expect(screen.queryByText("Named regions")).not.toBeInTheDocument();
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

  it("emits mutation intent and retains pending state until the refreshed job is terminal", async () => {
    const onMutate = vi.fn();
    const view = render(<JobsModal {...baseProps} onMutate={onMutate} jobs={[job]} />);
    await userEvent.click(screen.getByRole("button", { name: "Cancel Santa Cruz Mountains search" }));
    expect(onMutate).toHaveBeenCalledWith(job.id, "cancel");
    view.rerender(<JobsModal {...baseProps} onMutate={onMutate} pendingByJob={{ [job.id]: "cancelling" }} jobs={[job]} />);
    expect(screen.getByRole("button", { name: "Cancelling…" })).toBeDisabled();
    view.rerender(<JobsModal {...baseProps} pendingByJob={{ [job.id]: "cancelling" }} jobs={[{ ...job, status: "cancelled", partial: true }]} />);
    expect(screen.getByText("Cancelled", { exact: true })).toBeVisible();
    expect(screen.getByText("Partial results retained.")).toBeVisible();
  });

  it("retains saved data during a refresh error and offers retry", async () => {
    const onRefresh = vi.fn(async () => undefined);
    render(<JobsModal {...baseProps} jobs={[job]} loadState="error" loadError="Progress may be out of date." onRefresh={onRefresh} />);
    expect(screen.getByText("Santa Cruz Mountains")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(onRefresh).toHaveBeenCalledWith(true));
  });

  it("emits an ID for opening results and displays the owner's pending state", async () => {
    const onOpenResults = vi.fn();
    const completed: RouteJob = { ...job, status: "completed" };
    const view = render(<StrictMode><JobsModal {...baseProps} onOpenResults={onOpenResults} jobs={[completed]} /></StrictMode>);
    await userEvent.click(screen.getByRole("button", { name: /View results for/ }));
    expect(onOpenResults).toHaveBeenCalledWith(job.id);
    view.rerender(<JobsModal {...baseProps} jobs={[completed]} openingJobId={job.id} />);
    expect(screen.getByRole("button", { name: /View results for/ })).toHaveTextContent("Opening…");
  });
});
