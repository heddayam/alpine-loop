// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

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
    const request = {
      version: job.request.version,
      packId: job.request.packId,
      searchRegionId: job.request.searchRegionId,
      criteria: job.request.criteria,
      routesPerAccessPoint: job.request.routesPerAccessPoint,
    };
    const regionWide = { ...job, request };
    render(<JobsModal {...baseProps} jobs={[regionWide]} />);
    expect(screen.getByText("Entire reviewed region")).toBeVisible();
    expect(screen.queryByText(/min from/)).not.toBeInTheDocument();
  });

  it("labels drawn-area jobs as using the drawn boundary", () => {
    const drawnArea: RouteJob = {
      ...job,
      request: {
        version: 1,
        packId: job.request.packId,
        drawnAreaBbox: [-122.2, 37.1, -122.1, 37.2],
        criteria: job.request.criteria,
        routesPerAccessPoint: 10,
      },
      searchRegion: { id: "drawn-area", name: "Drawn boundary" },
    };
    render(<JobsModal {...baseProps} jobs={[drawnArea]} />);
    expect(screen.getAllByText("Drawn boundary")).toHaveLength(2);
    expect(screen.queryByText("Entire reviewed region")).not.toBeInTheDocument();
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
    expect(screen.queryByText(/Deletion requested/)).not.toBeInTheDocument();
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

  it("clears Opening after successfully loading results in Strict Mode", async () => {
    const completed = { ...job, status: "completed" as const, completedAt: "2026-08-06T00:00:15Z" };
    const page = { version: 1 as const, job: completed, results: [] };
    const onOpenResults = vi.fn();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(page), { status: 200 }));

    render(
      <StrictMode>
        <JobsModal {...baseProps} jobs={[completed]} onOpenResults={onOpenResults} />
      </StrictMode>,
    );
    await userEvent.click(screen.getByRole("button", { name: "View results for Santa Cruz Mountains" }));

    await waitFor(() => expect(onOpenResults).toHaveBeenCalledWith(page));
    expect(screen.getByRole("button", { name: "View results for Santa Cruz Mountains" })).toHaveTextContent("View results");
  });

  it("aborts and ignores a pending View results response when the modal closes", async () => {
    const response = deferred<Response>();
    let signal: AbortSignal | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      signal = init?.signal ?? undefined;
      return response.promise;
    });
    const onOpenResults = vi.fn();
    render(<JobsModal {...baseProps} jobs={[{ ...job, status: "completed", completedAt: "2026-08-06T00:00:15Z" }]} onOpenResults={onOpenResults} />);
    await userEvent.click(screen.getByRole("button", { name: "View results for Santa Cruz Mountains" }));
    fireEvent.click(screen.getByRole("button", { name: "Close jobs" }));
    expect(signal?.aborted).toBe(true);
    response.resolve(new Response(JSON.stringify({}), { status: 200 }));
    await act(async () => { await response.promise; });
    expect(onOpenResults).not.toHaveBeenCalled();
  });

  it("aborts pending View results work on unmount", async () => {
    const response = deferred<Response>();
    let signal: AbortSignal | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      signal = init?.signal ?? undefined;
      return response.promise;
    });
    const view = render(<JobsModal {...baseProps} jobs={[{ ...job, status: "completed", completedAt: "2026-08-06T00:00:15Z" }]} />);
    await userEvent.click(screen.getByRole("button", { name: "View results for Santa Cruz Mountains" }));
    view.unmount();
    expect(signal?.aborted).toBe(true);
    response.resolve(new Response(JSON.stringify({}), { status: 200 }));
  });
});
