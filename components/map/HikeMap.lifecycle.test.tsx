// @vitest-environment jsdom
import { type ComponentProps } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeatureCollection } from "geojson";
import type { GeneratedClosedRouteV3 } from "@/lib/contracts";
import { HikeMap } from "./HikeMap";

type Handler = (event: Record<string, unknown>) => void;
const recording = vi.hoisted(() => ({ maps: [] as RecordingMap[], markers: [] as RecordingMarker[] }));

class RecordingMarker {
  removed = false;
  constructor(readonly options: { element: HTMLElement }) { recording.markers.push(this); }
  setLngLat = vi.fn().mockReturnThis();
  addTo = vi.fn().mockReturnThis();
  remove = vi.fn(() => { this.removed = true; });
}
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
  project([x, y]: number[]) { return { x: x! * 1000, y: y! * 1000 }; }
  fitBounds = vi.fn();
  easeTo = vi.fn();
  queryRenderedFeatures = vi.fn(() => []);
  on(type: string, layerOrHandler: string | Handler, handler?: Handler) {
    const key = typeof layerOrHandler === "string" ? `${type}:${layerOrHandler}` : type;
    const set = this.handlers.get(key) ?? new Set();
    set.add(handler ?? layerOrHandler as Handler);
    this.handlers.set(key, set);
  }
  off(type: string, handler: Handler) { this.handlers.get(type)?.delete(handler); }
  emit(type: string, properties: Record<string, unknown> = {}, layer?: string, lngLat = { lng: -122, lat: 37 }) {
    const event = {
      type, point: { x: 100, y: 100 }, lngLat,
      preventDefault: vi.fn(), originalEvent: { button: 0, preventDefault: vi.fn() },
      features: [{ properties }],
    };
    this.handlers.get(layer ? `${type}:${layer}` : type)?.forEach((handler) => handler(event));
  }
  remove = vi.fn(() => { this.removed = true; this.handlers.clear(); });
}

vi.mock("maplibre-gl", () => ({
  Map: RecordingMap,
  Marker: RecordingMarker,
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
    selectedRouteId: routes[0]?.id, onBoundsChange: vi.fn(), onRouteSelect: vi.fn(), onRouteHover: vi.fn(), onSegmentSelect: vi.fn(), onSegmentHover: vi.fn() };
}
let resize: ResizeObserverCallback;
let disconnect: ReturnType<typeof vi.fn>;
beforeEach(() => {
  recording.maps.length = 0;
  recording.markers.length = 0;
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
    expect(routeUploads(map)).toEqual([["generated-routes", 1], ["generated-route-segments", 1]]);
    expect(map.getSource("generated-routes")?.data.features.map((feature) => feature.geometry)).toEqual(initial.routes.map(({ geometry }) => geometry));
    for (const hoveredRouteId of ["second", "first", undefined, "second"]) {
      view.rerender(<HikeMap {...initial} hoveredRouteId={hoveredRouteId} hoveredSegmentId="first:2" />);
    }
    expect(routeUploads(map)).toEqual([["generated-routes", 1], ["generated-route-segments", 1]]);
    expect(map.getLayer("generated-route-hover")?.filter).toEqual(["in", ["get", "id"], ["literal", ["second"]]]);
    expect(map.getLayer("generated-route-segment-focus")?.filter).toEqual(["in", ["get", "id"], ["literal", ["first:2"]]]);
    view.rerender(<HikeMap {...initial} selectedRouteId="second" hoveredRouteId="second" selectedSegmentId="second:1" />);
    expect(routeUploads(map)).toEqual([["generated-routes", 1], ["generated-route-segments", 2]]);
    expect(map.getSource("generated-route-segments")?.data.features.map(({ properties }) => properties?.routeId)).toEqual(["second", "second"]);
    expect(map.getLayer("generated-route-hover")?.filter).toEqual(["in", ["get", "id"], ["literal", []]]);
    expect(map.getLayer("generated-route-selected")?.filter).toEqual(["in", ["get", "id"], ["literal", ["second"]]]);
    expect(map.getLayer("generated-route-segment-focus")?.filter).toEqual(["in", ["get", "id"], ["literal", ["second:1"]]]);
    act(() => map.emit("click", { id: "second:1" }, "generated-route-segment-hit-target"));
    expect(initial.onSegmentSelect).toHaveBeenCalledWith("second:1");
    act(() => map.emit("mousemove", { id: "first" }, "generated-route-hit-target"));
    expect(initial.onRouteHover).toHaveBeenCalledWith("first");
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
    fireEvent.click(screen.getByRole("button", { name: "Draw trailhead filter" }));
    act(() => {
      map.emit("mousedown");
      map.emit("mousemove", { id: "second" }, "generated-route-hit-target");
      map.emit("click", { id: "second" }, "generated-route-hit-target");
      map.emit("click", { id: "first:1" }, "generated-route-segment-hit-target");
      map.emit("click", { id: "point", name: "Point" }, "access-points");
      map.emit("click", { trailGroupId: "trail", name: "Trail" }, "trail-network-hit-target");
      map.emit("contextmenu");
    });
    const pin = recording.markers.find((marker) => !marker.removed)!.options.element.querySelector("button")!;
    fireEvent.click(pin);
    expect(initial.onRouteSelect).not.toHaveBeenCalled();
    expect(initial.onSegmentSelect).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(map.canvas.style.cursor).toBe("crosshair");
    act(() => { map.emit("mousemove", {}, undefined, { lng: -121.9, lat: 37.1 }); map.emit("mouseup", {}, undefined, { lng: -121.9, lat: 37.1 }); });
    expect(initial.onBoundsChange).toHaveBeenCalledWith([-122, 37, -121.9, 37.1]);
    fireEvent.click(pin, { detail: 1 });
    act(() => { map.emit("click", { id: "second" }, "generated-route-hit-target"); });
    expect(initial.onRouteSelect).not.toHaveBeenCalled();
    // Keyboard activation has no new pointer press and remains available.
    fireEvent.click(pin, { detail: 0 });
    expect(initial.onRouteSelect).toHaveBeenCalledWith("first");
    act(() => { map.emit("mousedown"); map.emit("click", { id: "second" }, "generated-route-hit-target"); });
    expect(initial.onRouteSelect).toHaveBeenCalledWith("second");
  });

  it("resizes the retained map and cleans up requests, markers and listeners", async () => {
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
    expect(recording.markers.every(({ removed }) => removed)).toBe(true);
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
    expect(recording.markers).toHaveLength(0);
  });

});
