// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { catalog, plan, request, job, installation } from "../../tests/fixtures/coverage/catalog";
import { CoveragePanel } from "./CoveragePanel";
const response = (body: unknown) => ({ ok: true, json: async () => body });
const props = { open: true, selected: ["section"], onToggle: vi.fn() };
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it("reviews actual download and disk sizes, then submits the selected release sections", async () => {
  const fetcher = vi.fn(async (...[url]: [string, RequestInit?]) => response(url.endsWith("/plan") ? plan : url.endsWith("/jobs") ? job : catalog));
  vi.stubGlobal("fetch", fetcher);
  render(<CoveragePanel {...props} />);
  fireEvent.click(await screen.findByRole("button", { name: "Preview download" }));
  await screen.findByText("Download preview");
  expect(JSON.parse(fetcher.mock.calls.find(([url]) => url.endsWith("/plan"))![1]?.body as string)).toEqual(request);
  expect(screen.getByText("Additional disk required")).toBeVisible();
  expect(screen.getByText("1.3 MiB")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Download coverage" }));
  await screen.findByRole("button", { name: "Pause" });
  expect(fetcher).toHaveBeenCalledWith("/api/coverage/jobs", expect.objectContaining({ body: JSON.stringify(request) }));
});

it("invalidates the preview when section selection changes", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => response(url.endsWith("/plan") ? plan : catalog)));
  const view = render(<CoveragePanel {...props} />);
  fireEvent.click(await screen.findByRole("button", { name: "Preview download" }));
  await screen.findByText("Download preview");
  view.rerender(<CoveragePanel {...props} selected={[]} />);
  expect(screen.queryByRole("button", { name: "Download coverage" })).not.toBeInTheDocument();
});

it("aborts a pending preview on close and ignores its late response", async () => {
  let resolve!: (value: unknown) => void;
  let previewSignal: AbortSignal | undefined;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/plan")) { previewSignal = init?.signal as AbortSignal; return new Promise((done) => { resolve = done; }); }
    return response(catalog);
  }));
  const view = render(<CoveragePanel {...props} />);
  fireEvent.click(await screen.findByRole("button", { name: "Preview download" }));
  view.rerender(<CoveragePanel {...props} open={false} />);
  expect(previewSignal?.aborted).toBe(true);
  await act(async () => resolve(response(plan)));
  view.rerender(<CoveragePanel {...props} />);
  await screen.findByRole("button", { name: "Preview download" });
  expect(screen.queryByText("Download preview")).not.toBeInTheDocument();
});

it("resumes downloads and refreshes search only after atomic activation", async () => {
  const changed = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (url: string) => response(url.endsWith("/resume") ? { ...job, status: "completed", installation } : { ...catalog, jobs: [{ ...job, status: "paused" }] })));
  render(<CoveragePanel {...props} onChanged={changed} />);
  fireEvent.click(await screen.findByRole("button", { name: "Resume" }));
  await waitFor(() => expect(changed).toHaveBeenCalledOnce());
  expect(screen.getByText("1 installed")).toBeVisible();
});

it("does not let an old poll overwrite pause and stops polling while closed", async () => {
  vi.useFakeTimers();
  let reads = 0;
  let releasePoll!: (value: unknown) => void;
  let pollSignal: AbortSignal | undefined;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/pause")) return response({ ...job, status: "paused" });
    if (++reads === 2) { pollSignal = init?.signal as AbortSignal; return new Promise((resolve) => { releasePoll = resolve; }); }
    return response({ ...catalog, jobs: [job] });
  }));
  const view = render(<CoveragePanel {...props} />);
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  fireEvent.click(screen.getByRole("button", { name: "Pause" }));
  await act(async () => { await Promise.resolve(); });
  expect(pollSignal?.aborted).toBe(true);
  await act(async () => releasePoll(response({ ...catalog, jobs: [job] })));
  expect(screen.getByRole("button", { name: "Resume" })).toBeVisible();
  view.rerender(<CoveragePanel {...props} open={false} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(reads).toBe(2);
});

it("removes selected installed sections explicitly and announces the change", async () => {
  const changed = vi.fn(), onMapChange = vi.fn();
  let removed = false;
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "DELETE") { removed = true; return response({}); }
    return response({ ...catalog, installed: removed ? null : installation });
  });
  vi.stubGlobal("fetch", fetcher);
  render(<CoveragePanel {...props} onChanged={changed} onMapChange={onMapChange} />);
  fireEvent.click(await screen.findByRole("button", { name: "Remove selected coverage" }));
  await waitFor(() => expect(changed).toHaveBeenCalledOnce());
  expect(fetcher).toHaveBeenCalledWith("/api/coverage", expect.objectContaining({ method: "DELETE", body: JSON.stringify({ sectionIds: ["section"] }) }));
  expect(onMapChange.mock.lastCall![0].features.features[0].properties).toEqual({ sectionId: "section", status: "selected" });
});

it("requires explicit removal when a new catalog drops previously installed sections", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => response({ ...catalog, installed: { ...installation, releaseId: "old", sectionIds: ["retired"] } })));
  render(<CoveragePanel {...props} />);
  expect(await screen.findByRole("button", { name: "Preview update" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Remove unavailable sections (1)" })).toBeEnabled();
});


it("shows concise available and installed counts for map selection", async () => {
  const base = catalog.release!;
  const releaseGeometry = { type: "Polygon" as const, coordinates: [[[-123,46],[-120,46],[-120,49],[-123,49],[-123,46]]] };
  const onMapChange = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async () => response({ ...catalog, installed: installation, release: { ...base, geometry: releaseGeometry, sections: [...base.sections, { ...base.sections[0], id: "next" }, { ...base.sections[0], id: "farther" }] } })));
  const view = render(<CoveragePanel {...props} selected={["next"]} onMapChange={onMapChange} />);
  expect(await screen.findByText("2 available")).toBeVisible();
  expect(screen.getByText("1 installed")).toBeVisible();
  expect(screen.getByText("1 section selected · 256 KiB")).toBeVisible();
  expect(screen.getByRole("button", { name: "Preview download" })).toBeEnabled();
  expect(onMapChange.mock.lastCall![0].focus).toEqual([-123,46,-120,49]);
  expect(view.container.querySelector("details, summary, select, p")).toBeNull();
});

it("keeps update and removal controls when all catalog sections are installed", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => response({ ...catalog, installed: { ...installation, releaseId: "older" } })));
  render(<CoveragePanel {...props} />);
  expect(await screen.findByText("0 available")).toBeVisible();
  expect(screen.getByRole("button", { name: "Preview update" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Remove selected coverage" })).toBeEnabled();
});

it("labels partial releases without warning prose or completed download history", async () => {
  const limitation = "Partial benchmark coverage only; the full region is not available in this release.";
  vi.stubGlobal("fetch", vi.fn(async () => response({ ...catalog, installed: installation, release: { ...catalog.release!, limitations: [limitation] }, jobs: [{ ...job, status: "completed", installation }] })));
  render(<CoveragePanel {...props} />);
  expect(await screen.findByText("Limited coverage")).toBeVisible();
  expect(screen.queryByText(limitation)).not.toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "Active downloads" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Preview download" })).toBeDisabled();
  expect(screen.getByRole("link", { name: /OpenStreetMap contributors/ })).toHaveAttribute("href", "https://www.openstreetmap.org");
});
