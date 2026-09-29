// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { catalog, request, job, installation } from "../../tests/fixtures/coverage/catalog";
import { CoveragePanel } from "./CoveragePanel";
const response = (body: unknown) => ({ ok: true, json: async () => body });
const props = { open: true, selected: ["section"] };
function namedCatalog(updated = false) {
  const base = catalog.release!;
  const glacier = { ...base.artifacts[0], ...(updated ? { id: "b".repeat(64), path: `objects/${"b".repeat(64)}.sqlite.gz`, bytes: 2097152, compressedBytes: 524288 } : {}), graphId: "glacier", startGeometry: base.geometry };
  const jackson = { ...base.artifacts[0], id: "c".repeat(64), path: `objects/${"c".repeat(64)}.sqlite.gz`, bytes: 3145728, compressedBytes: 786432, graphId: "jackson", startGeometry: base.geometry };
  const area = { maximumRouteMiles: 40, bufferMiles: 25 };
  return { ...catalog, installed: installation, release: { ...base, id: "next-release", partitioning: "local-areas", artifacts: [glacier, jackson], sections: [
    { ...base.sections[0], name: "Glacier Peak area", artifactIds: [glacier.id], area },
    { ...base.sections[0], id: "next", name: "Henry M. Jackson area", artifactIds: [jackson.id], area },
  ] } };
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it("shows an empty download state without a filesystem error or download action", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => response({release:null,installed:null,jobs:[],error:null})));
  render(<CoveragePanel {...props} />);
  expect(await screen.findByText("No trail downloads available yet.")).toBeVisible();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Download" })).not.toBeInTheDocument();
});

it("downloads selected sections directly without a preview request", async () => {
  const fetcher = vi.fn(async (...[url]: [string, RequestInit?]) => response(url.endsWith("/jobs") ? job : catalog));
  vi.stubGlobal("fetch", fetcher);
  render(<CoveragePanel {...props} />);
  expect(await screen.findByText("1 section selected · up to 256 KiB download · 1.0 MiB active trail data after download")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Download" }));
  await screen.findByRole("button", { name: "Pause" });
  expect(fetcher).toHaveBeenCalledWith("/api/coverage/jobs", expect.objectContaining({ body: JSON.stringify(request) }));
  expect(fetcher.mock.calls.some(([url]) => url.endsWith("/plan"))).toBe(false);
});

it("shows a disk-space failure from the direct download request", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/jobs")
    ? { ok: false, json: async () => ({error:"Not enough disk space"}) } : response(catalog)));
  render(<CoveragePanel {...props} />);
  fireEvent.click(await screen.findByRole("button", { name: "Download" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Not enough disk space");
  expect(screen.getByRole("button", { name: "Download" })).toBeEnabled();
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
  let removed = false;
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "DELETE") { removed = true; return response({}); }
    return response({ ...catalog, installed: removed ? null : { ...installation, releaseId: "old", sectionIds: ["retired"] } });
  });
  vi.stubGlobal("fetch", fetcher);
  render(<CoveragePanel {...props} />);
  expect(await screen.findByRole("button", { name: "Download" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Remove unavailable sections (1)" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Download" })).toBeEnabled());
  expect(fetcher).toHaveBeenCalledWith("/api/coverage", expect.objectContaining({ method: "DELETE", body: JSON.stringify({ sectionIds: ["retired"] }) }));
});

it("updates retired areas to their declared replacement without removing installed coverage first", async () => {
  const next = namedCatalog();
  next.release.sections = [{ ...next.release.sections[0]!, id: "central-cascades", name: "Central Cascades", replaces: ["pilot-a", "pilot-b"] } as typeof next.release.sections[number]];
  next.release.artifacts = [next.release.artifacts[0]!];
  next.installed = { ...installation, sectionIds: ["pilot-a", "pilot-b"] };
  const fetcher = vi.fn(async (url: string) => response(url.endsWith("/jobs") ? job : next));
  vi.stubGlobal("fetch", fetcher);
  render(<CoveragePanel {...props} selected={[]} onSelectionChange={vi.fn()} />);
  expect(await screen.findByRole("button", { name: "Update" })).toBeEnabled();
  expect(screen.getByText("Central Cascades includes your earlier downloaded areas. They stay available until the update finishes.")).toBeVisible();
  expect(screen.queryByRole("button", { name: /Remove unavailable/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Update" }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/coverage/jobs", expect.objectContaining({ body: JSON.stringify({ releaseId: next.release.id, sectionIds: ["central-cascades"] }) })));
  expect(fetcher.mock.calls.some(call => (call as unknown as [string,RequestInit?])[1]?.method === "DELETE")).toBe(false);
});

it("shows concise available and installed counts for map selection", async () => {
  const base = catalog.release!;
  const releaseGeometry = { type: "Polygon" as const, coordinates: [[[-123,46],[-120,46],[-120,49],[-123,49],[-123,46]]] };
  const onMapChange = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async () => response({ ...catalog, installed: installation, release: { ...base, geometry: releaseGeometry, sections: [...base.sections, { ...base.sections[0], id: "next" }, { ...base.sections[0], id: "farther" }] } })));
  const view = render(<CoveragePanel {...props} selected={["next"]} onMapChange={onMapChange} />);
  expect(await screen.findByText("2 available")).toBeVisible();
  expect(screen.getByText("1 installed")).toBeVisible();
  expect(screen.getByText("1 section selected · up to 0 KiB download · 1.0 MiB active trail data after download")).toBeVisible();
  expect(screen.getByRole("button", { name: "Download" })).toBeEnabled();
  expect(onMapChange.mock.lastCall![0].focus).toEqual([-123,46,-120,49]);
  expect(view.container.querySelector("details, summary, select, p")).toBeNull();
});

it("does not offer an update just because the catalog release changed", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => response(namedCatalog())));
  const view = render(<CoveragePanel {...props} />);
  expect(await screen.findByRole("checkbox", { name: "Glacier Peak area Downloaded" })).toBeVisible();
  expect(screen.getByRole("checkbox", { name: "Henry M. Jackson area Available" })).toBeVisible();
  expect(screen.getByText("1 area selected · 1.0 MiB selected trail data")).toBeVisible();
  expect(screen.getByRole("button", { name: "Download" })).toBeDisabled();
  expect(screen.queryByRole("button", { name: "Update" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Remove selected coverage" })).toBeEnabled();
  view.rerender(<CoveragePanel {...props} selected={[]} />);
  expect(screen.queryByRole("button", { name: /Download|Update/ })).not.toBeInTheDocument();
});

it("downloads a new neighbor without updating the unchanged downloaded area", async () => {
  const next = namedCatalog();
  const fetcher = vi.fn(async (url: string) => response(url.endsWith("/jobs") ? { ...job, releaseId: "next-release", sectionIds: ["next", "section"] } : next));
  vi.stubGlobal("fetch", fetcher);
  render(<CoveragePanel {...props} selected={["next"]} />);
  expect(await screen.findByText("1 area selected · up to 768 KiB download · 4.0 MiB active trail data after download")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Update" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Download" }));
  expect(await screen.findByRole("checkbox", { name: "Henry M. Jackson area Downloading" })).toBeVisible();
  expect(screen.getByRole("checkbox", { name: "Glacier Peak area Downloaded" })).toBeVisible();
  expect(fetcher).toHaveBeenCalledWith("/api/coverage/jobs", expect.objectContaining({ body: JSON.stringify({ releaseId: "next-release", sectionIds: ["next", "section"] }) }));
});

it("offers an update when a downloaded area's artifact changes", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => response(namedCatalog(true))));
  render(<CoveragePanel {...props} />);
  expect(await screen.findByRole("checkbox", { name: "Glacier Peak area Update available" })).toBeVisible();
  expect(screen.getByRole("checkbox", { name: "Henry M. Jackson area Available" })).toBeVisible();
  expect(screen.getByText("1 area selected · up to 512 KiB download · 2.0 MiB active trail data after download")).toBeVisible();
  expect(screen.getByRole("button", { name: "Update" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Remove selected coverage" })).toBeEnabled();
});

it("includes downloaded-area updates in the neighbor download action and sizes", async () => {
  const next = namedCatalog(true);
  const fetcher = vi.fn(async (url: string) => response(url.endsWith("/jobs") ? { ...job, releaseId: "next-release", sectionIds: ["next", "section"] } : next));
  vi.stubGlobal("fetch", fetcher);
  render(<CoveragePanel {...props} selected={["next"]} />);
  expect(await screen.findByText("1 area selected · up to 1.3 MiB download · 5.0 MiB active trail data after download")).toBeVisible();
  expect(screen.getByText("Includes updates to 1 downloaded area.")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Download and update" }));
  expect(await screen.findByRole("checkbox", { name: "Glacier Peak area Downloading" })).toBeVisible();
  expect(screen.getByRole("checkbox", { name: "Henry M. Jackson area Downloading" })).toBeVisible();
  expect(fetcher).toHaveBeenCalledWith("/api/coverage/jobs", expect.objectContaining({ body: JSON.stringify({ releaseId: "next-release", sectionIds: ["next", "section"] }) }));
});

it("keeps release caveats and completed history out of the panel", async () => {
  const limitation = "Partial benchmark coverage only; the full region is not available in this release.";
  vi.stubGlobal("fetch", vi.fn(async () => response({ ...catalog, installed: installation, release: { ...catalog.release!, limitations: [limitation] }, jobs: [{ ...job, status: "completed", installation }] })));
  render(<CoveragePanel {...props} />);
  await screen.findByText("1 installed");
  expect(screen.queryByText("Limited coverage")).not.toBeInTheDocument();
  expect(screen.queryByText(limitation)).not.toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "Active downloads" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Download" })).toBeDisabled();
});


it("previews complete network extents and deduplicated sizes while reusing immutable installed files", async () => {
  const base = catalog.release!;
  const geometry = { type: "Polygon" as const, coordinates: [[[-124,45],[-119,45],[-119,50],[-124,50],[-124,45]]] };
  const onMapChange = vi.fn(), onShowArea = vi.fn();
  const nextArtifact = { ...base.artifacts[0], id: "b".repeat(64), path: `objects/${"b".repeat(64)}.sqlite.gz`, graphId: "next" };
  const network = { nodeCount: 4, physicalEdgeCount: 4, loopBlockCount: 1, sourceBoundaryLimited: true };
  vi.stubGlobal("fetch", vi.fn(async () => response({ ...catalog,
    installed: { ...installation, releaseId: "older" },
    release: { ...base, partitioning: "connected-networks", artifacts: [{ ...base.artifacts[0], graphId: "first" }, nextArtifact], sections: [
      { ...base.sections[0], network }, { id: "next", geometry, artifactIds: [nextArtifact.id], network: { ...network, sourceBoundaryLimited: false } },
    ] },
  })));
  render(<CoveragePanel {...props} selected={["section", "next", "next"]} onMapChange={onMapChange} onShowArea={onShowArea} />);
  expect(await screen.findByText("2 networks selected · up to 256 KiB download · 2.0 MiB active trail data after download")).toBeVisible();
  expect(screen.getByText("Trails may continue beyond the available data.")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Show selected area" }));
  expect(onMapChange.mock.lastCall![0]).toMatchObject({ focus: [-124,45,-119,50], focusRevision: 1 });
  expect(onShowArea).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Show selected area" }));
  expect(onMapChange.mock.lastCall![0].focusRevision).toBe(2);
});


it("guides map selection without empty summaries or inactive selection actions", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => response({ ...catalog, release: { ...catalog.release!, partitioning: "connected-networks", artifacts: catalog.release!.artifacts.map((file) => ({ ...file, graphId: "network-fixture" })), sections: catalog.release!.sections.map((section) => ({ ...section, network: { nodeCount: 4, physicalEdgeCount: 4, loopBlockCount: 1, sourceBoundaryLimited: true } })) } })));
  render(<CoveragePanel {...props} selected={["unknown"]} />);
  expect(await screen.findByText("Select a network on the map.")).toBeVisible();
  expect(screen.queryByText(/selected ·/)).not.toBeInTheDocument();
  expect(screen.queryByText(/download ·/)).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Download" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Show selected area" })).not.toBeInTheDocument();
  expect(screen.queryByText("Trails may continue beyond the available data.")).not.toBeInTheDocument();
});

it("can update installed coverage without a map selection and shows the update size", async () => {
  const release = catalog.release!;
  const replacement = { ...release.artifacts[0], id: "b".repeat(64), path: `objects/${"b".repeat(64)}.sqlite.gz`, compressedBytes: 524288, bytes: 2097152 };
  const updatedCatalog = { ...catalog, installed: { ...installation, releaseId: "older" }, release: { ...release, artifacts: [replacement], sections: [{ ...release.sections[0], artifactIds: [replacement.id] }] } };
  const fetcher = vi.fn(async (url: string) => response(url.endsWith("/jobs") ? job : updatedCatalog));
  vi.stubGlobal("fetch", fetcher);
  render(<CoveragePanel {...props} selected={[]} />);
  expect(await screen.findByText("Update downloaded trails · up to 512 KiB download · 2.0 MiB active trail data after download")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Show selected area" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Update" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Update" }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/coverage/jobs", expect.objectContaining({ body: JSON.stringify(request) })));
});


it("presents local areas as hike starts with surrounding trails included", async () => {
  const base = catalog.release!;
  const routing = { type: "Polygon" as const, coordinates: [[[-123,46],[-120,46],[-120,49],[-123,49],[-123,46]]] };
  const onMapChange = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async () => response({ ...catalog, release: { ...base, partitioning: "local-areas", geometry: routing,
    artifacts: base.artifacts.map(file => ({ ...file, graphId: "local", geometry: routing, startGeometry: base.sections[0].geometry })),
    sections: base.sections.map(section => ({ ...section, area: { maximumRouteMiles: 40, bufferMiles: 25 } })),
  } })));
  const view = render(<CoveragePanel {...props} selected={[]} onMapChange={onMapChange} />);
  expect(await screen.findByText("Select an area on the map.")).toBeVisible();
  expect(screen.getByText("Choose where hikes start. Downloads include surrounding trails for hikes up to 40 miles.")).toBeVisible();
  expect(onMapChange.mock.lastCall![0].features.features[0].geometry).toEqual(base.sections[0].geometry);
  expect(onMapChange.mock.lastCall![0].focus).toEqual([-122,47,-121.75,47.25]);
  view.rerender(<CoveragePanel {...props} onMapChange={onMapChange} />);
  expect(await screen.findByText("1 area selected · up to 256 KiB download · 1.0 MiB active trail data after download")).toBeVisible();
});


it("selects searchable named regions and reflects map selection without showing internal identities", async () => {
  const base = catalog.release!;
  const onSelectionChange = vi.fn(), onMapChange = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async () => response({...catalog,release:{...base,
    sections:[{...base.sections[0],name:"Glacier Peak area"},{...base.sections[0],id:"opaque-internal-id",name:"Pasayten area"}],
    limitations:["US-only coverage; the international border is a hard limit."],
  }})));
  const view = render(<CoveragePanel open selected={[]} onSelectionChange={onSelectionChange} onMapChange={onMapChange} />);
  expect(await screen.findByRole("heading", {name:"Download trails"})).toBeVisible();
  const glacier = await screen.findByRole("checkbox", {name:"Glacier Peak area Available"});
  fireEvent.click(glacier);
  expect(onSelectionChange).toHaveBeenLastCalledWith(["section"]);
  view.rerender(<CoveragePanel open selected={["section"]} onSelectionChange={onSelectionChange} onMapChange={onMapChange} />);
  expect(glacier).toBeChecked();
  expect(onMapChange.mock.lastCall![0].features.features[0].properties.status).toBe("selected");
  expect(screen.getByText("US trails only. Routes stop at the international border.")).toBeVisible();
  fireEvent.change(screen.getByRole("searchbox", {name:"Find a region"}), {target:{value:"pasayten"}});
  expect(screen.queryByRole("checkbox", {name:/Glacier/})).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("checkbox", {name:"Pasayten area Available"}));
  expect(onSelectionChange).toHaveBeenLastCalledWith(["section","opaque-internal-id"]);
  expect(screen.queryByText("opaque-internal-id")).not.toBeInTheDocument();
  view.rerender(<CoveragePanel open selected={["opaque-internal-id"]} onSelectionChange={onSelectionChange} />);
  expect(screen.getByRole("checkbox", {name:"Pasayten area Available"})).toBeChecked();
  fireEvent.click(screen.getByRole("checkbox", {name:"Pasayten area Available"}));
  expect(onSelectionChange).toHaveBeenLastCalledWith([]);
  fireEvent.change(screen.getByRole("searchbox", {name:"Find a region"}), {target:{value:"missing"}});
  expect(screen.getByText("No matching regions.")).toBeVisible();
});
