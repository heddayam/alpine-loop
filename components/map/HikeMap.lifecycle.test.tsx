// @vitest-environment jsdom
import { type ComponentProps } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeatureCollection } from "geojson";
import type { GeneratedClosedRouteV3 } from "@/lib/contracts";
import { routeStart } from "../results/route-start";
import { HikeMap } from "./HikeMap";

type Handler = (event: Record<string, unknown>) => void;
const recording = vi.hoisted(() => ({ maps: [] as RecordingMap[] }));

class RecordingMap {
  sources = new Map<string, { data: FeatureCollection; setData: ReturnType<typeof vi.fn>; getClusterExpansionZoom: ReturnType<typeof vi.fn> }>();
  layers = new Map<string, Record<string, unknown>>();
  handlers = new Map<string, Set<Handler>>();
  canvas = document.createElement("canvas");
  removed = false;
  constructor() { recording.maps.push(this); }
  addControl = vi.fn();
  resize = vi.fn();
  dragPan = { enable: vi.fn(), disable: vi.fn() };
  addSource(id: string, options: { data: FeatureCollection }) {
    const source = { data: options.data, setData: vi.fn((data: FeatureCollection) => { source.data = data; }), getClusterExpansionZoom: vi.fn().mockResolvedValue(14) };
    this.sources.set(id, source);
  }
  getSource(id: string) { return this.sources.get(id); }
  addLayer(layer: { id: string }) { this.layers.set(layer.id, layer); }
  getLayer(id: string) { return this.layers.get(id); }
  setFilter = vi.fn((id: string, filter: unknown) => { this.layers.get(id)!.filter = filter; });
  setPaintProperty = vi.fn();
  setLayoutProperty = vi.fn();
  getCanvas() { return this.canvas; }
  getZoom() { return 13; }
  getBounds() { return { getWest: () => -123, getSouth: () => 36, getEast: () => -120, getNorth: () => 39, contains: () => true }; }
  fitBounds = vi.fn();
  easeTo = vi.fn();
  queryRenderedFeatures = vi.fn<(point: unknown, options: { layers: string[] }) => Array<{ properties: Record<string, unknown> }>>(() => []);
  on(type: string, layerOrHandler: string | Handler, handler?: Handler) {
    const key = typeof layerOrHandler === "string" ? `${type}:${layerOrHandler}` : type;
    const set = this.handlers.get(key) ?? new Set();
    set.add(handler ?? layerOrHandler as Handler);
    this.handlers.set(key, set);
  }
  off(type: string, handler: Handler) { this.handlers.get(type)?.delete(handler); }
  emit(type: string, properties: Record<string, unknown> = {}, layer?: string, lngLat = { lng: -122, lat: 37 }, features = [{ properties }]) {
    const event = {
      type, point: { x: 100, y: 100 }, lngLat,
      preventDefault: vi.fn(), originalEvent: { button: 0, preventDefault: vi.fn() },
      features,
    };
    this.handlers.get(layer ? `${type}:${layer}` : type)?.forEach((handler) => handler(event));
  }
  remove = vi.fn(() => { this.removed = true; this.handlers.clear(); });
}

vi.mock("maplibre-gl", () => ({
  Map: RecordingMap,
  NavigationControl: class {},
  setWorkerUrl: vi.fn(),
}));

function route(id: string, longitude = -122): GeneratedClosedRouteV3 {
  // Geometry/identity are the map's only inputs from the full route contract.
  return {
    id,
    geometry: { type: "LineString", coordinates: [[longitude, 37], [longitude + 0.1, 37.1], [longitude, 37]] },
    startAccessPoint: { id: `start:${id}`, name: `Start ${id}`, lon: longitude, lat: 37 },
    topology: { kind: "simple-loop" },
    trailSegments: [1, 2].map((number) => ({ id: `${id}:${number}`, name: "Trail", geometry: { type: "LineString", coordinates: [[longitude, 37], [longitude + 0.1, 37.1]] } })),
  } as GeneratedClosedRouteV3;
}
const display = { center: [-122, 37] as [number, number], zoom: 13 };
function props(routes = [route("first"), route("second", -121.8)]): ComponentProps<typeof HikeMap> {
  return { drawBounds: null, coverages: [], showRegionBoundaries: false, display, includeUncertainAccess: true, routes,
    selectedRouteId: routes[0]?.id, onBoundsChange: vi.fn(), onStartSelect: vi.fn(), onRouteSelect: vi.fn(), onRouteHover: vi.fn(), onSegmentSelect: vi.fn(), onSegmentHover: vi.fn() };
}
let resize: ResizeObserverCallback;
let disconnect: ReturnType<typeof vi.fn>;
beforeEach(() => {
  recording.maps.length = 0;
  disconnect = vi.fn();
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: ResizeObserverCallback) { resize = callback; }
    observe = vi.fn();
    disconnect = disconnect;
  });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ accessPoints: [], trailNetwork: { type: "FeatureCollection", features: [] } }) }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
async function loadMap() {
  await waitFor(() => expect(recording.maps).toHaveLength(1));
  const map = recording.maps[0]!;
  await act(async () => { map.emit("load"); });
  return map;
}
function routeUploads(map: RecordingMap) {
  return [...map.sources].filter(([id]) => id.startsWith("generated-")).map(([id, source]) => [id, source.setData.mock.calls.length]);
}

describe("MapLibre workspace lifecycle", () => {
  it("uploads route geometry once and updates hover/selection through filters", async () => {
    const initial = props();
    const view = render(<HikeMap {...initial} />);
    const map = await loadMap();
    expect(routeUploads(map)).toEqual([["generated-routes", 1], ["generated-route-segments", 1], ["generated-starts", 1]]);
    expect(map.getSource("generated-routes")?.data.features.map((feature) => feature.geometry)).toEqual(initial.routes.map(({ geometry }) => geometry));
    for (const hoveredRouteId of ["second", "first", undefined, "second"]) {
      view.rerender(<HikeMap {...initial} hoveredRouteId={hoveredRouteId} hoveredSegmentId="first:2" />);
    }
    expect(routeUploads(map)).toEqual([["generated-routes", 1], ["generated-route-segments", 1], ["generated-starts", 1]]);
    expect(map.getLayer("generated-route-hover")?.filter).toEqual(["in", ["get", "id"], ["literal", ["second"]]]);
    expect(map.getLayer("generated-route-segment-focus")?.filter).toEqual(["in", ["get", "id"], ["literal", []]]);
    view.rerender(<HikeMap {...initial} selectedRouteId="second" hoveredRouteId="second" selectedSegmentId="second:1" />);
    expect(routeUploads(map)).toEqual([["generated-routes", 1], ["generated-route-segments", 2], ["generated-starts", 1]]);
    expect(map.getSource("generated-route-segments")?.data.features.map(({ properties }) => properties?.routeId)).toEqual(["second", "second"]);
    expect(map.getLayer("generated-route-hover")?.filter).toEqual(["in", ["get", "id"], ["literal", []]]);
    expect(map.getLayer("generated-route-selected")?.filter).toEqual(["in", ["get", "id"], ["literal", ["second"]]]);
    expect(map.getLayer("generated-route-segment-focus")?.filter).toEqual(["in", ["get", "id"], ["literal", ["second:1"]]]);
    act(() => map.emit("click", { id: "second:1" }, "generated-route-segment-hit-target"));
    expect(initial.onSegmentSelect).toHaveBeenCalledWith("second:1");
    act(() => map.emit("mousemove", { id: "first" }, "generated-route-hit-target"));
    expect(initial.onRouteHover).toHaveBeenCalledWith("first");
  });

  it("renders native start circles and counts, and delegates route activation to the panel", async () => {
    const first = route("first");
    const shared = { ...route("shared"), startAccessPoint: first.startAccessPoint };
    const initial = props([first, shared, route("elsewhere", -121.8)]);
    const view = render(<HikeMap {...initial} />);
    const map = await loadMap();
    const key = routeStart(first).key;
    expect(map.getSource("generated-starts")?.data.features.map(({ properties }) => properties?.count)).toEqual([2, 1]);
    expect(map.getLayer("generated-starts")).toMatchObject({ type: "circle", source: "generated-starts" });
    expect(map.getLayer("generated-start-counts")).toMatchObject({ type: "symbol", layout: { "text-field": ["to-string", ["get", "count"]], "text-font": ["sans-serif"] } });
    act(() => map.emit("click", { key }, "generated-starts"));
    act(() => map.emit("click", { id: shared.id, startKey: key }, "generated-route-hit-target"));
    expect(initial.onStartSelect).toHaveBeenCalledExactlyOnceWith(key);
    expect(initial.onRouteSelect).toHaveBeenCalledExactlyOnceWith(shared.id);
    const latestSelect = vi.fn();
    view.rerender(<HikeMap {...initial} selectedStartKey={key} onStartSelect={latestSelect} />);
    act(() => map.emit("click", { key }, "generated-starts"));
    expect(latestSelect).toHaveBeenCalledWith(key);
    expect(map.setPaintProperty).toHaveBeenCalledWith("generated-starts", "circle-color", ["case", ["==", ["get", "key"], key], "#d83b20", "#2f6a55"]);
    expect(recording.maps).toHaveLength(1);
    expect(map.getSource("generated-starts")?.setData).toHaveBeenCalledOnce();
  });

  it("prioritizes starts over overlapping route and segment gestures", async () => {
    const initial = props();
    render(<HikeMap {...initial} />);
    const map = await loadMap();
    map.queryRenderedFeatures.mockImplementation((_point, options) => options.layers.includes("generated-starts") ? [{ properties: { key: "start" } }] : []);
    act(() => {
      map.emit("click", { id: "first", startKey: "start" }, "generated-route-hit-target");
      map.emit("click", { id: "first:1" }, "generated-route-segment-hit-target");
      map.emit("mousemove", { id: "first" }, "generated-route-hit-target");
      map.emit("mousemove", { id: "first:1" }, "generated-route-segment-hit-target");
      map.emit("mousemove", { key: "start", name: "Start", count: 2 }, "generated-starts");
      map.emit("click", { key: "start" }, "generated-starts");
    });
    expect(initial.onStartSelect).toHaveBeenCalledExactlyOnceWith("start");
    expect(initial.onSegmentSelect).not.toHaveBeenCalled();
    expect(initial.onRouteHover).not.toHaveBeenCalledWith("first");
    expect(initial.onSegmentHover).not.toHaveBeenCalledWith("first:1");
    expect(screen.getByRole("status").textContent).toBe("2 routesStart");
    act(() => map.emit("movestart"));
    expect(screen.queryByRole("status")).toBeNull();
    expect(map.canvas.style.cursor).toBe("");
  });

  it("keeps overview segment geometry empty and routes directly selectable", async () => {
    const initial = { ...props(), selectedRouteId: undefined };
    const view = render(<HikeMap {...initial} />);
    const map = await loadMap();
    expect(map.getSource("generated-route-segments")?.data.features).toEqual([]);
    act(() => {
      map.emit("mousemove", { id: "first:1" }, "generated-route-segment-hit-target");
      map.emit("click", { id: "first:1" }, "generated-route-segment-hit-target");
      map.emit("mousemove", { id: "second" }, "generated-route-hit-target");
      map.emit("click", { id: "second" }, "generated-route-hit-target");
    });
    expect(initial.onSegmentHover).not.toHaveBeenCalledWith("first:1");
    expect(initial.onSegmentSelect).not.toHaveBeenCalled();
    expect(initial.onRouteHover).toHaveBeenCalledWith("second");
    expect(initial.onRouteSelect).toHaveBeenCalledWith("second");
    view.rerender(<HikeMap {...initial} selectedRouteId="second" />);
    expect(map.getSource("generated-route-segments")?.data.features).toHaveLength(2);
    view.rerender(<HikeMap {...initial} />);
    expect(map.getSource("generated-route-segments")?.data.features).toEqual([]);
  });

  it("layers a crisp preview above selection and dims context without uploading or moving", async () => {
    const initial = props();
    const view = render(<HikeMap {...initial} />);
    const map = await loadMap();
    const uploads = routeUploads(map);
    const framing = map.fitBounds.mock.calls.length;
    view.rerender(<HikeMap {...initial} hoveredRouteId="second" />);
    const layers = [...map.layers.keys()];
    expect(layers.indexOf("generated-route-hover-casing")).toBeGreaterThan(layers.indexOf("generated-route-selected"));
    expect(layers.indexOf("generated-route-hover")).toBeGreaterThan(layers.indexOf("generated-route-hover-casing"));
    expect(map.getLayer("generated-route-hover-casing")?.filter).toEqual(map.getLayer("generated-route-hover")?.filter);
    expect(map.setPaintProperty).toHaveBeenCalledWith("generated-route-alternates", "line-opacity", 0.2);
    expect(map.setPaintProperty).toHaveBeenCalledWith("generated-route-selected", "line-opacity", 0.3);
    expect(map.getLayer("generated-route-hover-casing")).toMatchObject({ paint: { "line-color": "#fffdf7" } });
    view.rerender(<HikeMap {...initial} />);
    expect(map.setPaintProperty).toHaveBeenLastCalledWith("generated-route-segment-focus", "line-width", expect.any(Array));
    expect(map.setPaintProperty).toHaveBeenCalledWith("generated-route-selected", "line-opacity", 1);
    expect(map.fitBounds).toHaveBeenCalledTimes(framing);
    expect(routeUploads(map)).toEqual(uploads);
  });

  it("scopes route previews and uses an independent trailhead ring without geometry uploads", async () => {
    const initial = { ...props(), selectedRouteId: undefined };
    const view = render(<HikeMap {...initial} />);
    const map = await loadMap();
    const key = routeStart(initial.routes[0]!).key;
    const uploads = routeUploads(map);
    view.rerender(<HikeMap {...initial} selectedStartKey={key} />);
    expect(map.setPaintProperty).toHaveBeenCalledWith("generated-route-alternates", "line-opacity", ["case", ["==", ["get", "startKey"], key], 0.8, 0.16]);
    expect(map.setPaintProperty).toHaveBeenCalledWith("generated-starts", "circle-stroke-width", ["case", ["==", ["get", "key"], key], 3, 0]);
    expect(map.setPaintProperty).toHaveBeenCalledWith("generated-starts", "circle-color", ["case", ["==", ["get", "key"], ""], "#d83b20", "#2f6a55"]);
    act(() => {
      map.emit("mousemove", { id: "second", startKey: "elsewhere" }, "generated-route-hit-target");
      map.emit("click", { id: "second", startKey: "elsewhere" }, "generated-route-hit-target");
      map.emit("mousemove", { id: "first", startKey: key }, "generated-route-hit-target");
    });
    expect(initial.onRouteHover).not.toHaveBeenCalledWith("second");
    expect(initial.onRouteHover).toHaveBeenCalledWith("first");
    expect(initial.onRouteSelect).toHaveBeenCalledWith("second");
    expect(routeUploads(map)).toEqual(uploads);
  });

  it("opens the route it previews when scoped and outside routes overlap", async () => {
    const initial = { ...props(), selectedRouteId: undefined };
    const key = routeStart(initial.routes[0]!).key;
    render(<HikeMap {...initial} selectedStartKey={key} />);
    const map = await loadMap();
    const features = [{ properties: { id: "second", startKey: "elsewhere" } }, { properties: { id: "first", startKey: key } }];
    act(() => {
      map.emit("mousemove", {}, "generated-route-hit-target", undefined, features);
      map.emit("click", {}, "generated-route-hit-target", undefined, features);
    });
    expect(initial.onRouteHover).toHaveBeenCalledExactlyOnceWith("first");
    expect(initial.onRouteSelect).toHaveBeenCalledExactlyOnceWith("first");
  });

  it("preserves priority hover across unrelated layer leaves and clears it on pan and cleanup", async () => {
    const initial = props();
    const view = render(<HikeMap {...initial} />);
    const map = await loadMap();
    act(() => {
      map.emit("mousemove", { id: "first:1" }, "generated-route-segment-hit-target");
      map.emit("mouseleave", {}, "generated-route-hit-target");
      map.emit("mouseleave", {}, "access-points");
    });
    expect(initial.onSegmentHover).toHaveBeenLastCalledWith("first:1");
    act(() => map.emit("movestart"));
    expect(initial.onRouteHover).toHaveBeenLastCalledWith(undefined);
    expect(initial.onSegmentHover).toHaveBeenLastCalledWith(undefined);
    act(() => {
      map.emit("mousemove", { id: "first:2" }, "generated-route-segment-hit-target");
    });
    expect(initial.onSegmentHover).toHaveBeenLastCalledWith(undefined);
    act(() => {
      map.emit("moveend");
      map.emit("mousemove", { key: "start", name: "Start", count: 2 }, "generated-starts");
      map.emit("mouseleave", {}, "access-points");
      map.emit("mouseleave", {}, "generated-route-hit-target");
    });
    expect(screen.getByRole("status").textContent).toBe("2 routesStart");
    act(() => map.emit("mousemove", { id: "first:2" }, "generated-route-segment-hit-target"));
    view.unmount();
    expect(initial.onSegmentHover).toHaveBeenLastCalledWith(undefined);
    expect(initial.onRouteHover).toHaveBeenLastCalledWith(undefined);
  });

  it("temporarily emphasizes the hovered segment and restores the pinned segment", async () => {
    const initial = props();
    const view = render(<HikeMap {...initial} selectedSegmentId="first:1" />);
    const map = await loadMap();
    const uploads = routeUploads(map);
    view.rerender(<HikeMap {...initial} selectedSegmentId="first:1" hoveredSegmentId="first:2" />);
    expect(map.getLayer("generated-route-segment-focus")?.filter).toEqual(["in", ["get", "id"], ["literal", ["first:2"]]]);
    view.rerender(<HikeMap {...initial} selectedSegmentId="first:1" />);
    expect(map.getLayer("generated-route-segment-focus")?.filter).toEqual(["in", ["get", "id"], ["literal", ["first:1"]]]);
    expect(routeUploads(map)).toEqual(uploads);
  });

  it("uses the latest inputs after a delayed load and frames changes to middle result IDs", async () => {
    const initial = props([route("a"), route("b"), route("c")]);
    const view = render(<HikeMap {...initial} />);
    await waitFor(() => expect(recording.maps).toHaveLength(1));
    const routes = [route("a"), route("different-middle", -120), route("c")];
    view.rerender(<HikeMap {...initial} routes={routes} selectedRouteId="different-middle" />);
    const map = await loadMap();
    expect(map.getSource("generated-routes")?.data.features.map(({ properties }) => properties?.id)).toEqual(["a", "different-middle", "c"]);
    expect(map.getSource("generated-route-segments")?.data.features[0]?.properties?.routeId).toBe("different-middle");
    expect(map.fitBounds).toHaveBeenCalledTimes(1);
    view.rerender(<HikeMap {...initial} />);
    expect(map.fitBounds).toHaveBeenCalledTimes(2);
    view.rerender(<HikeMap {...initial} selectedRouteId="c" />);
    expect(map.fitBounds).toHaveBeenCalledTimes(2);
  });

  it("gives drawing exclusive gestures and suppresses the click after completion", async () => {
    const initial = props();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<HikeMap {...initial} />);
    const map = await loadMap();
    act(() => map.emit("mousemove", { id: "first:1" }, "generated-route-segment-hit-target"));
    fireEvent.click(screen.getByRole("button", { name: "Draw trailhead filter" }));
    expect(initial.onSegmentHover).toHaveBeenLastCalledWith(undefined);
    expect(initial.onRouteHover).toHaveBeenLastCalledWith(undefined);
    act(() => {
      map.emit("mousedown");
      map.emit("mousemove", { id: "second" }, "generated-route-hit-target");
      map.emit("click", { id: "second" }, "generated-route-hit-target");
      map.emit("click", { id: "first:1" }, "generated-route-segment-hit-target");
      map.emit("click", { id: "point", name: "Point" }, "access-points");
      map.emit("click", { trailGroupId: "trail", name: "Trail" }, "trail-network-hit-target");
      map.emit("contextmenu");
    });
    act(() => map.emit("click", { key: "first-start" }, "generated-starts"));
    expect(initial.onStartSelect).not.toHaveBeenCalled();
    expect(initial.onRouteSelect).not.toHaveBeenCalled();
    expect(initial.onSegmentSelect).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(map.canvas.style.cursor).toBe("crosshair");
    act(() => { map.emit("mousemove", {}, undefined, { lng: -121.9, lat: 37.1 }); map.emit("mouseup", {}, undefined, { lng: -121.9, lat: 37.1 }); });
    expect(initial.onBoundsChange).toHaveBeenCalledWith([-122, 37, -121.9, 37.1]);
    act(() => map.emit("click", { key: "first-start" }, "generated-starts"));
    act(() => { map.emit("click", { id: "second" }, "generated-route-hit-target"); });
    expect(initial.onStartSelect).not.toHaveBeenCalled();
    expect(initial.onRouteSelect).not.toHaveBeenCalled();
    act(() => { map.emit("mousedown"); map.emit("click", { id: "second", startKey: "second-start" }, "generated-route-hit-target"); });
    expect(initial.onRouteSelect).toHaveBeenCalledWith("second");
    act(() => map.emit("click", { key: "first-start" }, "generated-starts"));
    expect(initial.onStartSelect).toHaveBeenCalledWith("first-start");
  });

  it("resizes the retained map and cleans up requests and native listeners", async () => {
    const view = render(<HikeMap {...props()} />);
    const map = await loadMap();
    act(() => resize([], {} as ResizeObserver));
    expect(map.resize).toHaveBeenCalledOnce();
    const signal = vi.mocked(fetch).mock.calls.at(-1)?.[1]?.signal;
    expect(signal?.aborted).toBe(false);
    view.unmount();
    expect(signal?.aborted).toBe(true);
    expect(map.remove).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
    expect([...map.handlers.values()].every((handlers) => handlers.size === 0)).toBe(true);
    act(() => resize([], {} as ResizeObserver));
    expect(map.resize).toHaveBeenCalledOnce();
  });
  it("ignores a late load from a removed map", async () => {
    const view = render(<HikeMap {...props()} />);
    await waitFor(() => expect(recording.maps).toHaveLength(1));
    const map = recording.maps[0]!;
    const pendingLoad = [...map.handlers.get("load")!][0]!;
    view.unmount();
    act(() => pendingLoad({}));
    expect(map.sources.size).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

});
