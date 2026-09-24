// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { CoverageCatalog, CoverageJob, CoveragePlan } from "@/lib/contracts/coverage";
import { CoveragePanel } from "./CoveragePanel";

const geometry: CoveragePlan["geometry"] = { type: "Polygon" as const, coordinates: [[[-122, 47], [-121, 47], [-121, 48], [-122, 48], [-122, 47]]] };
const plan: CoveragePlan = { id: "plan", request: { collectionIds: ["cascades"], memoryLimitMiB: 4096, offline: false }, geometry, sourceIds: ["osm"], units: [{ id: "unit", geometry, status: "pending" }], estimates: { downloadBytes: null, temporaryBytes: null, reusableBytes: 0 }, warnings: ["Estimates are not available yet."] };
const catalog: CoverageCatalog = { collections: [{ id: "cascades", name: "Washington Cascades", geometry, sourceIds: ["osm"], limitations: [] }], installed: null, jobs: [], prerequisites: [{ id: "osmium", available: false, instructions: "Install osmium." }] };
const job: CoverageJob = { id: "job", plan, status: "running", stage: "Preparing trails", completedUnits: 0, totalUnits: 1, createdAt: "2026-09-24T00:00:00Z", updatedAt: "2026-09-24T00:00:00Z", error: null, snapshot: null };
const response = (body: unknown) => ({ ok: true, json: async () => body });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it("previews drawn coverage with the memory budget, shows unknown estimates, and installs only the reviewed plan", async () => {
  // Request arguments are captured to verify the submitted installation contract.
  const fetcher = vi.fn(async (...[url]: [string, RequestInit?]) => response(url.endsWith("/plan") ? plan : url.endsWith("/jobs") ? job : catalog));
  vi.stubGlobal("fetch", fetcher);
  render(<CoveragePanel open geometry={geometry} />);
  await screen.findByLabelText("Washington Cascades");
  fireEvent.click(screen.getByLabelText(/Use cached sources only/));
  fireEvent.click(screen.getByRole("button", { name: "Preview installation" }));
  await screen.findByText("Installation preview");
  expect(JSON.parse(fetcher.mock.calls.find(([url]) => url.endsWith("/plan"))![1]?.body as string)).toEqual({ collectionIds: [], geometry, memoryLimitMiB: 4096, offline: true });
  expect(screen.getAllByText("Unknown until sources are checked")).toHaveLength(2);
  expect(screen.getByText(/Missing: osmium/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Start installation" }));
  await screen.findByText(/Preparing trails/);
  expect(fetcher).toHaveBeenCalledWith("/api/coverage/jobs", expect.objectContaining({ body: JSON.stringify({ planId: "plan" }) }));
});

it("invalidates a reviewed plan when its inputs change", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => response(url.endsWith("/plan") ? plan : catalog)));
  render(<CoveragePanel open />);
  fireEvent.click(await screen.findByLabelText("Washington Cascades"));
  fireEvent.click(screen.getByRole("button", { name: "Preview installation" }));
  await screen.findByText("Installation preview");
  fireEvent.change(screen.getByLabelText("Memory budget (MiB)"), { target: { value: "2048" } });
  expect(screen.queryByRole("button", { name: "Start installation" })).not.toBeInTheDocument();
});

it("aborts a pending preview on close and ignores its late response", async () => {
  let resolve!: (value: unknown) => void;
  let previewSignal: AbortSignal | undefined;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/plan")) { previewSignal = init?.signal as AbortSignal; return new Promise((done) => { resolve = done; }); }
    return response(catalog);
  }));
  const view = render(<CoveragePanel open />);
  fireEvent.click(await screen.findByLabelText("Washington Cascades"));
  fireEvent.click(screen.getByRole("button", { name: "Preview installation" }));
  view.rerender(<CoveragePanel open={false} />);
  expect(previewSignal?.aborted).toBe(true);
  await act(async () => resolve(response(plan)));
  view.rerender(<CoveragePanel open />);
  await screen.findByLabelText("Washington Cascades");
  expect(screen.queryByText("Installation preview")).not.toBeInTheDocument();
});

it("offers publish only for paused prepared units, resumes failures, and announces publication", async () => {
  const prepared = { ...job, status: "paused" as const, completedUnits: 1, plan: { ...plan, units: [{ ...plan.units[0], status: "prepared" as const }] } };
  const snapshot = { schemaVersion: 1, id: "snapshot", dataVersion: "version", geometry, unitIds: ["unit"], createdAt: job.createdAt, sourceFingerprint: "source", auditStatus: "passed", limitations: [] };
  const changed = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (url: string) => response(url.endsWith("/publish") ? { ...prepared, status: "completed", snapshot, plan: { ...plan, units: [{ ...plan.units[0], status: "installed" }] } } : { ...catalog, jobs: [prepared, { ...job, id: "failed", status: "failed" }] })));
  render(<CoveragePanel open onChanged={changed} />);
  await screen.findByRole("button", { name: "Install ready sections" });
  expect(screen.getAllByRole("button", { name: "Resume" })).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "Install ready sections" }));
  await waitFor(() => expect(changed).toHaveBeenCalledOnce());
  expect(screen.queryByRole("button", { name: "Install ready sections" })).not.toBeInTheDocument();
});

it("does not let an old poll overwrite a pause and stops polling while closed", async () => {
  vi.useFakeTimers();
  let catalogReads = 0;
  let releasePoll!: (value: unknown) => void;
  let pollSignal: AbortSignal | undefined;
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/pause")) return response({ ...job, status: "paused" });
    catalogReads++;
    if (catalogReads === 2) { pollSignal = init?.signal as AbortSignal; return new Promise((resolve) => { releasePoll = resolve; }); }
    return response({ ...catalog, jobs: [job] });
  });
  vi.stubGlobal("fetch", fetcher);
  const view = render(<CoveragePanel open />);
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  fireEvent.click(screen.getByRole("button", { name: "Pause" }));
  await act(async () => { await Promise.resolve(); });
  expect(pollSignal?.aborted).toBe(true);
  await act(async () => releasePoll(response({ ...catalog, jobs: [job] })));
  expect(screen.getByRole("button", { name: "Resume" })).toBeVisible();
  view.rerender(<CoveragePanel open={false} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(catalogReads).toBe(2);
});

it("shows selected coverage spatially and distinguishes unavailable, processing, and installed sections", async () => {
  const installed = { schemaVersion: 1 as const, id: "local-coverage", dataVersion: "before", geometry, unitIds: ["old"], createdAt: job.createdAt, sourceFingerprint: "source", auditStatus: "passed" as const, limitations: [] };
  const splitPlan = { ...plan, units: [
    { id: "working", geometry, status: "processing" },
    { id: "missing", geometry: { ...geometry, coordinates: [...geometry.coordinates, [[-121.9,47.1],[-121.8,47.1],[-121.8,47.2],[-121.9,47.2],[-121.9,47.1]]] }, status: "unavailable", reason: "outside-configured-source-coverage" },
  ] };
  const onMapChange = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (url: string) => response(url.endsWith("/plan") ? splitPlan : { ...catalog, installed })));
  render(<CoveragePanel open onMapChange={onMapChange} />);
  fireEvent.click(await screen.findByLabelText("Washington Cascades"));
  fireEvent.click(screen.getByRole("button", { name: "Preview installation" }));
  await screen.findByText("Installation preview");
  const features = onMapChange.mock.lastCall![0].features.features;
  expect(features.map((item: {properties:{status:string}}) => item.properties.status)).toEqual(expect.arrayContaining(["pending", "processing", "installed", "unavailable"]));
  expect(features.find((item: {properties:{status:string}}) => item.properties.status === "unavailable").geometry.coordinates).toHaveLength(2);
  expect(screen.getByText(/Map sources can omit trails/)).toBeVisible();
  expect(screen.getByText(/Requested and processing areas are not available/)).toBeVisible();
  fireEvent.click(screen.getByText("Coverage status (2 sections)"));
  expect(screen.getByText(/No map source covers this area/)).toBeVisible();
});

it("refreshes the search catalog when a partial publication advances the same coverage identity", async () => {
  const before = { schemaVersion: 1, id: "local-coverage", dataVersion: "before", geometry, unitIds: ["old"], createdAt: job.createdAt, sourceFingerprint: "source", auditStatus: "passed", limitations: [] };
  const paused = { ...job, status: "paused", completedUnits: 1, plan: { ...plan, units: [{ ...plan.units[0], status: "prepared" }] }, snapshot: before };
  const after = { ...before, dataVersion: "after", unitIds: ["old", "new"] };
  const changed = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (url: string) => response(url.endsWith("/publish") ? { ...paused, snapshot: after, status: "completed", plan: { ...plan, units: [{ ...plan.units[0], status: "installed" }] } } : { ...catalog, installed: before, jobs: [paused] })));
  render(<CoveragePanel open onChanged={changed} />);
  fireEvent.click(await screen.findByRole("button", { name: "Install ready sections" }));
  await waitFor(() => expect(changed).toHaveBeenCalledOnce());
  expect(screen.getByText(/2 sections installed/)).toBeVisible();

});
