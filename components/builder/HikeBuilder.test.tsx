// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HikeBuilder } from "./HikeBuilder";
import { useJobs } from "./useJobs";
import type { AppSettingsV1 } from "@/lib/contracts";
import type { SearchRequest, SearchResult, RouteJobV2 } from "@/lib/contracts/search";
import { DEFAULT_APP_SETTINGS } from "@/lib/settings/defaults";
const router = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("../map/HikeMap", () => ({ HikeMap: ({ onBoundsChange, routes = [], filterGeometry, includeUncertainAccess }: {
  onBoundsChange: (bounds: [number, number, number, number]) => void;
  routes?: Array<{ id: string }>; filterGeometry?: unknown; includeUncertainAccess?: boolean;
}) => <div aria-label="Mock map"><button onClick={() => onBoundsChange([-122.18, 37.15, -122.13, 37.18])}>Draw fixture area</button><button onClick={() => onBoundsChange([-122.17, 37.15, -122.13, 37.18])}>Change fixture area</button><output aria-label="Map routes">{routes.map(({ id }) => id).join(",")}</output><output aria-label="Map context">{JSON.stringify({ filterGeometry, includeUncertainAccess })}</output></div> }));
const appSettings = DEFAULT_APP_SETTINGS;
const catalog = { regions: [{ id: "castle-rock", name: "Castle Rock" }, { id: "sunol", name: "Sunol" }], coverages: [{ type: "Polygon", coordinates: [[[-122.2,37.1],[-122.1,37.1],[-122.1,37.2],[-122.2,37.2],[-122.2,37.1]]] }], display: { center: [-122.15,37.15], zoom: 12 } };
const request: SearchRequest = { area: { mode: "drawn-area", bbox: [-122.18,37.15,-122.13,37.18] }, criteria: { closedRoute: { maximumRepeatedTrailPct: 35, allowMultiCycle: true }, distanceMiles: { min: 1, max: 4 }, includeUncertainAccess: true }, limit: 10 };
const generatedRoute: SearchResult["exact"][number] = {
  regionLabel: "Santa Cruz Mountains",
  id: "exact-route", geometry: { type: "LineString", coordinates: [[-122.16, 37.16], [-122.12, 37.19], [-122.16, 37.16]] },
  startAccessPoint: { id: "trailhead-a", name: "Fixture Trailhead", lon: -122.16, lat: 37.16, accessState: "public", confidence: "high" },
  distanceMeters: 6400, elevationGainMeters: 300, elevationLossMeters: 300, minimumElevationMeters: 300, maximumElevationMeters: 600,
  steepestSustainedGradePct: 9, topology: { kind: "simple-loop", cycleCount: 1, cycleBlockCount: 1, repeatedTrailDistanceMeters: 0, repeatedTrailFraction: 0, sharedStemDistanceMeters: 0, connectorCount: 0 }, trailNames: ["Fixture Ridge"], warnings: [],
  source: { freshness: "2026-08-01T00:00:00Z", confidence: "high", sourceIds: ["fixture"] },
};

const searchResponse = (request: SearchRequest): SearchResult => ({ request, area: { label: "Saved area", filterGeometry: { type: "Polygon", coordinates: [[[-122.18,37.15],[-122.13,37.15],[-122.13,37.18],[-122.18,37.18],[-122.18,37.15]]] } }, exact: [generatedRoute], nearMisses: [], incomplete: false, messages: [] });
const job: RouteJobV2 = { version: 2, id: "3d594650-3436-4f8b-a0e8-38d13fc148ca", status: "completed", request: { area: request.area, criteria: request.criteria }, area: searchResponse(request).area, progress: { eligibleAccessPointCount: 2, processedAccessPointCount: 2, exactRouteCount: 1, nearMissRouteCount: 0, truncatedAccessPointCount: 0, elapsedMs: 100 }, partial: false, stale: true, createdAt: "2026-08-06T00:00:00Z", updatedAt: "2026-08-06T00:00:01Z" };
const savedPage = { version: 2, job, results: [{ matchType: "exact", accessPointId: "trailhead-a", route: generatedRoute }] };
function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status }); }
function mockBaseFetch(onRequest?: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    const custom = onRequest?.(url, init);
    if (custom) return custom;
    if (url === "/api/settings") return json(appSettings);
    if (url === "/api/search/catalog") return json(catalog);
    if (url === "/api/search") return json(searchResponse(JSON.parse(String(init?.body))));
    if (url.includes("/results?")) return json(savedPage);
    if (url === "/api/route-jobs") return json(init?.method === "POST" ? job : { version: 2, jobs: [job] });
    if (url.endsWith("/cancel") || init?.method === "DELETE") return json({ ok: true });
    throw new Error(`Unexpected test request: ${url}`);
  });
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((complete) => { resolve = complete; }); return { promise, resolve }; }
async function chooseRegions() {
  await userEvent.click(await screen.findByRole("button", { name: "Regions: Choose regions" }));
  await userEvent.click(screen.getByRole("checkbox", { name: "Castle Rock" }));
  await userEvent.click(screen.getByRole("checkbox", { name: "Sunol" }));
  await userEvent.keyboard("{Escape}");
}
beforeEach(() => { mockBaseFetch(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); router.replace.mockReset(); });

describe("geographic workspace", () => {
  it("has one geographic form and an honest no-data state", async () => {
    vi.restoreAllMocks();
    mockBaseFetch((url) => url === "/api/search/catalog" ? json({ ...catalog, coverages: [], regions: [] }) : undefined);
    render(<HikeBuilder />);
    expect(await screen.findByText(/No hiking data is installed/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Quick search" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Full search" })).toBeDisabled();
    expect(screen.queryByRole("navigation", { name: "Region packs" })).not.toBeInTheDocument();
  });
  it("sends one Quick request and one Full intent for several named regions", async () => {
    render(<HikeBuilder />);
    await chooseRegions();
    await userEvent.click(screen.getByRole("button", { name: "Quick search" }));
    await screen.findByRole("heading", { name: "Exact matches" });
    await userEvent.click(screen.getByRole("button", { name: "Full search" }));
    await screen.findByRole("dialog", { name: "Jobs" });
    const calls = vi.mocked(fetch).mock.calls;
    const quick = calls.filter(([url]) => url === "/api/search");
    const full = calls.filter(([url, init]) => url === "/api/route-jobs" && init?.method === "POST");
    expect(quick).toHaveLength(1); expect(full).toHaveLength(1);
    expect(JSON.parse(String(quick[0]?.[1]?.body))).toMatchObject({ area: { mode: "named-regions", regionIds: ["castle-rock", "sunol"] }, limit: 10 });
    expect(JSON.parse(String(full[0]?.[1]?.body))).toEqual({ area: { mode: "named-regions", regionIds: ["castle-rock", "sunol"] }, criteria: request.criteria });
    expect(calls.some(([url]) => /packs|reachability|routes\/generate/.test(String(url)))).toBe(false);
  });
  it("drawn bounds override origin and regions, while unresolved origin never broadens a search", async () => {
    render(<HikeBuilder />);
    await chooseRegions();
    fireEvent.change(screen.getByLabelText("Driving origin"), { target: { value: "unresolved address" } });
    await userEvent.click(screen.getByRole("button", { name: "Full search" }));
    expect(await screen.findByText(/Choose a suggested origin or clear/)).toBeVisible();
    expect(vi.mocked(fetch).mock.calls.some(([url, init]) => url === "/api/route-jobs" && init?.method === "POST")).toBe(false);
    await userEvent.click(screen.getByText("Draw fixture area"));
    await userEvent.click(screen.getByRole("button", { name: "Quick search" }));
    await screen.findByRole("heading", { name: "Exact matches" });
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls.find(([url]) => url === "/api/search")?.[1]?.body)).area).toEqual(request.area);
  });
  it("sends resolved driving criteria directly without provider polling", async () => {
    render(<HikeBuilder />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Quick search" })).toBeEnabled());
    fireEvent.change(screen.getByLabelText("Driving origin"), { target: { value: "37.16, -122.16" } });
    await userEvent.click(screen.getByRole("button", { name: "Quick search" }));
    await screen.findByRole("heading", { name: "Exact matches" });
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls.find(([url]) => url === "/api/search")?.[1]?.body)).area).toMatchObject({ mode: "drive-time", regionIds: [], durationMinutes: 30, origin: { lon: -122.16, lat: 37.16 } });
  });
  it("cancels stale Quick completion after drawing another area", async () => {
    vi.restoreAllMocks(); const pending = deferred<Response>(); let signal: AbortSignal | undefined;
    mockBaseFetch((url, init) => { if (url === "/api/search") { signal = init?.signal as AbortSignal; return pending.promise; } });
    render(<HikeBuilder />); await userEvent.click(await screen.findByText("Draw fixture area"));
    await userEvent.click(screen.getByRole("button", { name: "Quick search" }));
    await userEvent.click(screen.getByText("Change fixture area"));
    expect(signal?.aborted).toBe(true);
    await act(async () => pending.resolve(json(searchResponse(request))));
    expect(screen.getByLabelText("Map routes")).toHaveTextContent("");
    expect(screen.queryByRole("heading", { name: "Exact matches" })).not.toBeInTheDocument();
  });
  it("restores stale saved geometry in Strict Mode and keeps its context separate from draft edits", async () => {
    render(<StrictMode><HikeBuilder restoreJobId={job.id} /></StrictMode>);
    await screen.findByRole("heading", { name: "Exact matches" });
    expect(screen.getByText("Built with an older pack version.")).toBeVisible();
    const before = screen.getByLabelText("Map context").textContent;
    fireEvent.change(screen.getByLabelText("Distance minimum"), { target: { value: "8" } });
    expect(screen.getByLabelText("Map context")).toHaveTextContent(before!);
    expect(screen.getByText(/Viewing Saved area · 1–4 mi/)).toBeVisible();
    expect(screen.getByLabelText("Driving origin")).toHaveValue("");
    expect(router.replace).toHaveBeenCalledWith("/");
    await userEvent.click(screen.getByRole("button", { name: "Jobs" }));
    expect(await screen.findByRole("button", { name: /View results for Saved area/ })).toBeVisible();
  });
  it("uses the same result operation for pagination and ignores completion after closing Jobs", async () => {
    vi.restoreAllMocks(); const pending = deferred<Response>(); let signal: AbortSignal | undefined;
    mockBaseFetch((url, init) => { if (url.includes("/results?")) { signal = init?.signal as AbortSignal; return pending.promise; } });
    render(<HikeBuilder />); await userEvent.click(screen.getByRole("button", { name: "Jobs" }));
    await userEvent.click(await screen.findByRole("button", { name: /View results for Saved area/ }));
    await userEvent.click(screen.getByRole("button", { name: "Close jobs" }));
    expect(signal?.aborted).toBe(true);
    await act(async () => pending.resolve(json(savedPage)));
    expect(screen.queryByRole("heading", { name: "Exact matches" })).not.toBeInTheDocument();
  });
  it("advances a saved page without replacing the draft or leaving a loading state", async () => {
    vi.restoreAllMocks();
    mockBaseFetch((url) => url.includes("/results?") ? json(url.includes("cursor=") ? { ...savedPage, results: [{ ...savedPage.results[0], route: { ...generatedRoute, id: "second-page" } }] } : { ...savedPage, nextCursor: "next" }) : undefined);
    render(<HikeBuilder restoreJobId={job.id} />);
    await userEvent.click(await screen.findByRole("button", { name: "Next 50 routes" }));
    await waitFor(() => expect(screen.getByLabelText("Map routes")).toHaveTextContent("second-page"));
    expect(screen.getByRole("button", { name: "Last page" })).toBeDisabled();
  });
  it("resolves the compact grade preset into numeric constraints and persists edits", async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    render(<HikeBuilder />);
    await userEvent.click(screen.getByRole("checkbox", { name: "Grade" }));
    await userEvent.selectOptions(screen.getByLabelText("Grade preset"), "steep");
    expect(screen.getByLabelText("Selected climbing grade")).toHaveTextContent("18%");
    await userEvent.click(await screen.findByRole("button", { name: "Draw fixture area" }));
    await userEvent.click(screen.getByRole("button", { name: "Quick search" }));
    await screen.findByRole("heading", { name: "Exact matches" });
    const generationCall = fetchMock.mock.calls.find(([input]) => String(input) === "/api/search");
    expect(JSON.parse(String(generationCall?.[1]?.body))).toMatchObject({ criteria: { gradeExperience: appSettings.gradePresets.steep } });
    expect(fetchMock.mock.calls.some(([input, init]) => String(input) === "/api/settings" && init?.method === "PUT")).toBe(true);

    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.clear(screen.getByLabelText("Moderate climb grade"));
    await userEvent.type(screen.getByLabelText("Moderate climb grade"), "13");
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Settings" })).not.toBeInTheDocument());
    const saves = fetchMock.mock.calls.filter(([input, init]) => String(input) === "/api/settings" && init?.method === "PUT");
    expect(JSON.parse(String(saves.at(-1)?.[1]?.body))).toMatchObject({ includeUncertainAccess: true, quickSearchRouteCount: 10, gradePresets: { moderate: { maximumClimbP90Pct: 13 } } });
  });

  it("waits for saved preferences before allowing a search", async () => {
    vi.restoreAllMocks();
    const settingsResponse = deferred<Response>();
    mockBaseFetch((url) => url === "/api/settings" ? settingsResponse.promise : undefined);
    render(<HikeBuilder />);
    expect(screen.getByRole("button", { name: "Settings" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Quick search" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Full search" })).toBeDisabled();
    await userEvent.click(await screen.findByRole("button", { name: "Draw fixture area" }));
    await act(async () => settingsResponse.resolve(new Response(JSON.stringify({
      ...appSettings, includeUncertainAccess: false, quickSearchRouteCount: 3,
    }))));
    expect(screen.getByRole("button", { name: "Full search" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "Quick search" }));
    await screen.findByRole("heading", { name: "Exact matches" });
    const generated = vi.mocked(globalThis.fetch).mock.calls.find(([url]) => url === "/api/search");
    expect(JSON.parse(String(generated?.[1]?.body))).toMatchObject({ criteria: { includeUncertainAccess: false }, limit: 3 });
  });

  it("serializes rapid preference changes without losing either server value", async () => {
    vi.restoreAllMocks();
    const firstSave = deferred<void>();
    const writes: AppSettingsV1[] = [];
    let stored: AppSettingsV1 | undefined;
    mockBaseFetch((url, init) => {
      if (url !== "/api/settings" || init?.method !== "PUT") return undefined;
      const next = JSON.parse(String(init.body)) as AppSettingsV1;
      writes.push(next);
      const complete = () => {
        stored = next;
        return new Response(JSON.stringify(next), { status: 200 });
      };
      return writes.length === 1 ? firstSave.promise.then(complete) : complete();
    });
    render(<HikeBuilder />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Settings" })).toBeEnabled());
    (screen.getByText("Loop options").closest("details") as HTMLDetailsElement).open = true;
    fireEvent.click(screen.getByRole("checkbox", { name: "Grade" }));
    fireEvent.click(screen.getByRole("switch", { name: /Allow figure-eights/ }));
    expect(screen.getByRole("checkbox", { name: "Grade" })).toBeChecked();
    expect(screen.getByRole("switch", { name: /Allow figure-eights/ })).not.toBeChecked();
    await waitFor(() => expect(writes).toHaveLength(1));
    await act(async () => firstSave.resolve());
    await waitFor(() => expect(stored).toMatchObject({ gradeConstraintEnabled: true, loopOptions: { allowMultiCycle: false } }));
    expect(writes).toHaveLength(2);
  });

  it.each(["", "101"])("keeps incomplete or invalid loop input %j out of unrelated preference saves", async (value) => {
    render(<HikeBuilder />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Settings" })).toBeEnabled());
    (screen.getByText("Loop options").closest("details") as HTMLDetailsElement).open = true;
    const repeated = screen.getByLabelText("Maximum repeated trail");
    fireEvent.change(repeated, { target: { value } });
    fireEvent.blur(repeated);
    fireEvent.click(screen.getByRole("checkbox", { name: "Grade" }));
    await waitFor(() => {
      const saves = vi.mocked(globalThis.fetch).mock.calls.filter(([url, init]) => url === "/api/settings" && init?.method === "PUT");
      expect(saves).toHaveLength(1);
      expect(JSON.parse(String(saves[0]?.[1]?.body))).toMatchObject({
        gradeConstraintEnabled: true, loopOptions: { maximumRepeatedTrailPct: 35 },
      });
    });
    expect(repeated).toHaveValue(value ? Number(value) : null);
  });

  it("keeps cancelled and failed modal edits out of active settings and permits retry", async () => {
    vi.restoreAllMocks();
    let attempts = 0;
    mockBaseFetch((url, init) => {
      if (url !== "/api/settings" || init?.method !== "PUT") return undefined;
      attempts += 1;
      return new Response(JSON.stringify({}), { status: attempts === 1 ? 500 : 200 });
    });
    render(<HikeBuilder />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Settings" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.change(screen.getByLabelText("Quick-search routes"), { target: { value: "12" } });
    await userEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(attempts).toBe(0);
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByLabelText("Quick-search routes")).toHaveValue(10);
    fireEvent.change(screen.getByLabelText("Quick-search routes"), { target: { value: "12" } });
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(await screen.findByText("Settings could not be saved. Check the values and try again.")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Close settings" }));
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByLabelText("Quick-search routes")).toHaveValue(10);
    fireEvent.change(screen.getByLabelText("Quick-search routes"), { target: { value: "12" } });
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Settings" })).not.toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByLabelText("Quick-search routes")).toHaveValue(12);
    expect(attempts).toBe(2);
  });

});


it("serializes slow job refreshes and continues polling until a deletion disappears", async () => {
  vi.useFakeTimers();
  vi.restoreAllMocks();
  const pendingPage = deferred<Response>();
  let listCalls = 0;
  mockBaseFetch((url, init) => {
    if (url !== "/api/route-jobs" || init?.method) return undefined;
    listCalls += 1;
    if (listCalls === 3) return pendingPage.promise;
    return json({ version: 2, jobs: [{ ...job, status: listCalls === 1 ? "running" : "deleting" }] });
  });
  const { result } = renderHook(() => useJobs(true));
  await act(async () => {});
  await act(async () => { await result.current.mutate(job.id, "delete"); });
  expect(result.current.pending[job.id]).toBe("deleting");
  expect(result.current.jobs[0]?.status).toBe("deleting");
  await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
  expect(listCalls).toBe(3);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20_000);
    document.dispatchEvent(new Event("visibilitychange"));
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(listCalls).toBe(3);
  await act(async () => { pendingPage.resolve(json({ version: 2, jobs: [] })); });
  expect(result.current.jobs).toEqual([]);
  expect(result.current.pending).toEqual({});
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  expect(listCalls).toBe(3);
});
