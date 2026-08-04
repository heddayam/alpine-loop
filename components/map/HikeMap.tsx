"use client";

import { useEffect, useRef, useState } from "react";
import type { FeatureCollection, LineString, Point } from "geojson";
import type { Map as MapLibreMap, MapLayerMouseEvent, MapMouseEvent, GeoJSONSource } from "maplibre-gl";
import type { GeneratedRoute } from "@/lib/contracts";
import type { AccessPointOption, Bounds } from "../builder/types";
import { boundsContainBounds, boundsCorners, boundsDimensionsMiles, boundsPolygon, normalizeBounds } from "./geometry";

type HikeMapProps = {
  bounds: Bounds | null;
  packCoverage: Bounds;
  suggestedBounds: Bounds;
  accessPoints: AccessPointOption[];
  selectedAccessPointId?: string;
  routes: GeneratedRoute[];
  selectedRouteId?: string;
  onBoundsChange: (bounds: Bounds | null) => void;
  onAccessPointSelect: (id: string) => void;
  onRouteSelect: (id: string) => void;
};

type ScreenBox = { left: number; top: number; width: number; height: number };

const EMPTY_POINTS: FeatureCollection<Point> = { type: "FeatureCollection", features: [] };
const EMPTY_LINES: FeatureCollection<LineString> = { type: "FeatureCollection", features: [] };

function accessPointFeatures(accessPoints: AccessPointOption[], selectedAccessPointId?: string): FeatureCollection<Point> {
  return {
    type: "FeatureCollection",
    features: accessPoints.map((point) => ({
      type: "Feature",
      properties: { id: point.id, name: point.name, selected: point.id === selectedAccessPointId },
      geometry: { type: "Point", coordinates: [point.lon, point.lat] },
    })),
  };
}

export function routeFeatures(routes: GeneratedRoute[], selectedRouteId?: string): FeatureCollection<LineString> {
  return {
    type: "FeatureCollection",
    features: routes.map((route, index) => ({
      type: "Feature",
      properties: {
        id: route.id,
        selected: route.id === selectedRouteId,
        routeNumber: index + 1,
        shape: route.shape,
      },
      geometry: route.geometry,
    })),
  };
}

function screenBoxForBounds(map: MapLibreMap, bounds: Bounds): ScreenBox {
  const [west, south, east, north] = bounds;
  const northwest = map.project([west, north]);
  const southeast = map.project([east, south]);
  return {
    left: Math.min(northwest.x, southeast.x),
    top: Math.min(northwest.y, southeast.y),
    width: Math.abs(southeast.x - northwest.x),
    height: Math.abs(southeast.y - northwest.y),
  };
}

export function HikeMap({
  bounds,
  packCoverage,
  suggestedBounds,
  accessPoints,
  selectedAccessPointId,
  routes,
  selectedRouteId,
  onBoundsChange,
  onAccessPointSelect,
  onRouteSelect,
}: HikeMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const startRef = useRef<[number, number] | null>(null);
  const boundsRef = useRef(bounds);
  const accessPointsRef = useRef(accessPoints);
  const selectedAccessPointIdRef = useRef(selectedAccessPointId);
  const routesRef = useRef(routes);
  const selectedRouteIdRef = useRef(selectedRouteId);
  const [drawing, setDrawing] = useState(false);
  const [draftBounds, setDraftBounds] = useState<Bounds | null>(null);
  const [coverageScreenBox, setCoverageScreenBox] = useState<ScreenBox | null>(null);
  const [committedScreenBox, setCommittedScreenBox] = useState<ScreenBox | null>(null);
  const [draftScreenBox, setDraftScreenBox] = useState<ScreenBox | null>(null);
  const [mapReady, setMapReady] = useState(false);

  useEffect(() => {
    boundsRef.current = bounds;
  }, [bounds]);

  useEffect(() => {
    accessPointsRef.current = accessPoints;
    selectedAccessPointIdRef.current = selectedAccessPointId;
  }, [accessPoints, selectedAccessPointId]);

  useEffect(() => {
    routesRef.current = routes;
    selectedRouteIdRef.current = selectedRouteId;
  }, [routes, selectedRouteId]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    let alive = true;
    let map: MapLibreMap | null = null;
    void import("maplibre-gl").then(({ Map, NavigationControl }) => {
      if (!alive || !containerRef.current) return;
      map = new Map({
        container: containerRef.current,
        center: [-122.16, 37.165],
        zoom: 12.4,
        attributionControl: { compact: true },
        style: {
          version: 8,
          sources: {
            "usgs-topo": {
              type: "raster",
              tiles: [
                "https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}",
              ],
              tileSize: 256,
              attribution: "USGS The National Map",
            },
          },
          layers: [{ id: "usgs-topo", type: "raster", source: "usgs-topo" }],
        },
      });
      mapRef.current = map;
      map.addControl(new NavigationControl({ showCompass: false }), "top-right");
      map.on("load", () => {
        const initialBounds = boundsRef.current;
        map?.addSource("pack-coverage", { type: "geojson", data: boundsPolygon(packCoverage) });
        map?.addLayer({
          id: "pack-coverage-fill",
          type: "fill",
          source: "pack-coverage",
          paint: { "fill-color": "#2a705a", "fill-opacity": 0.08 },
        });
        map?.addLayer({
          id: "pack-coverage-line",
          type: "line",
          source: "pack-coverage",
          paint: { "line-color": "#245b4b", "line-width": 2, "line-dasharray": [3, 2] },
        });
        map?.addSource("hard-boundary", { type: "geojson", data: initialBounds ? boundsPolygon(initialBounds) : EMPTY_POINTS });
        map?.addLayer({
          id: "hard-boundary-fill",
          type: "fill",
          source: "hard-boundary",
          paint: { "fill-color": "#ed7b4f", "fill-opacity": 0.16 },
        });
        map?.addLayer({
          id: "hard-boundary-line",
          type: "line",
          source: "hard-boundary",
          paint: { "line-color": "#a53d1f", "line-width": 3, "line-dasharray": [2, 1] },
        });
        map?.addSource("boundary-preview", { type: "geojson", data: EMPTY_POINTS });
        map?.addLayer({
          id: "boundary-preview-fill",
          type: "fill",
          source: "boundary-preview",
          paint: { "fill-color": "#f47b4d", "fill-opacity": 0.27 },
        });
        map?.addLayer({
          id: "boundary-preview-casing",
          type: "line",
          source: "boundary-preview",
          paint: { "line-color": "#fffaf0", "line-width": 7, "line-opacity": 0.95 },
        });
        map?.addLayer({
          id: "boundary-preview-line",
          type: "line",
          source: "boundary-preview",
          paint: { "line-color": "#a53d1f", "line-width": 4, "line-dasharray": [2, 1] },
        });
        map?.addSource("boundary-preview-corners", { type: "geojson", data: EMPTY_POINTS });
        map?.addLayer({
          id: "boundary-preview-corners",
          type: "circle",
          source: "boundary-preview-corners",
          paint: {
            "circle-radius": 6,
            "circle-color": "#f47b4d",
            "circle-stroke-color": "#fffaf0",
            "circle-stroke-width": 3,
          },
        });
        map?.addSource("access-points", {
          type: "geojson",
          data: accessPointFeatures(accessPointsRef.current, selectedAccessPointIdRef.current),
        });
        map?.addLayer({
          id: "access-points",
          type: "circle",
          source: "access-points",
          paint: {
            "circle-radius": ["case", ["==", ["get", "selected"], true], 9, 6],
            "circle-color": ["case", ["==", ["get", "selected"], true], "#ed7b4f", "#173f35"],
            "circle-stroke-color": "#fffaf0",
            "circle-stroke-width": 2,
          },
        });
        map?.addSource("generated-routes", {
          type: "geojson",
          data: routeFeatures(routesRef.current, selectedRouteIdRef.current),
        });
        map?.addLayer({
          id: "generated-route-alternate-casing",
          type: "line",
          source: "generated-routes",
          filter: ["!=", ["get", "selected"], true],
          paint: { "line-color": "#18312a", "line-width": 7, "line-opacity": 0.8, "line-dasharray": [2, 1.5] },
        });
        map?.addLayer({
          id: "generated-route-alternates",
          type: "line",
          source: "generated-routes",
          filter: ["!=", ["get", "selected"], true],
          paint: { "line-color": "#fffaf0", "line-width": 3, "line-opacity": 0.95, "line-dasharray": [2, 3.5] },
        });
        map?.addLayer({
          id: "generated-route-selected-casing",
          type: "line",
          source: "generated-routes",
          filter: ["==", ["get", "selected"], true],
          paint: { "line-color": "#173f35", "line-width": 10, "line-opacity": 0.95 },
        });
        map?.addLayer({
          id: "generated-route-selected",
          type: "line",
          source: "generated-routes",
          filter: ["==", ["get", "selected"], true],
          paint: { "line-color": "#f47b4d", "line-width": 6 },
        });
        const selectRoute = (event: MapLayerMouseEvent) => {
          const id = event.features?.[0]?.properties?.id;
          if (typeof id === "string") onRouteSelect(id);
        };
        map?.on("click", "generated-route-alternates", selectRoute);
        map?.on("click", "generated-route-selected", selectRoute);
        map?.on("click", "access-points", (event) => {
          const id = event.features?.[0]?.properties?.id;
          if (typeof id === "string") onAccessPointSelect(id);
        });
        setMapReady(true);
      });
    });
    return () => {
      alive = false;
      map?.remove();
      mapRef.current = null;
    };
  }, [onAccessPointSelect, onRouteSelect, packCoverage]);

  useEffect(() => {
    const source = mapRef.current?.getSource("hard-boundary") as GeoJSONSource | undefined;
    source?.setData(bounds ? boundsPolygon(bounds) : EMPTY_POINTS);
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const syncScreenBox = () => setCommittedScreenBox(bounds ? screenBoxForBounds(map, bounds) : null);
    syncScreenBox();
    map.on("move", syncScreenBox);
    map.on("resize", syncScreenBox);
    return () => {
      map.off("move", syncScreenBox);
      map.off("resize", syncScreenBox);
    };
  }, [bounds, mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const syncCoverageBox = () => setCoverageScreenBox(screenBoxForBounds(map, packCoverage));
    syncCoverageBox();
    map.on("move", syncCoverageBox);
    map.on("resize", syncCoverageBox);
    return () => {
      map.off("move", syncCoverageBox);
      map.off("resize", syncCoverageBox);
    };
  }, [mapReady, packCoverage]);

  useEffect(() => {
    const source = mapRef.current?.getSource("access-points") as GeoJSONSource | undefined;
    source?.setData(accessPointFeatures(accessPoints, selectedAccessPointId));
  }, [accessPoints, selectedAccessPointId]);

  useEffect(() => {
    const source = mapRef.current?.getSource("generated-routes") as GeoJSONSource | undefined;
    source?.setData(routes.length > 0 ? routeFeatures(routes, selectedRouteId) : EMPTY_LINES);
  }, [routes, selectedRouteId]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !drawing) return;
    const previewSource = map.getSource("boundary-preview") as GeoJSONSource | undefined;
    const cornerSource = map.getSource("boundary-preview-corners") as GeoJSONSource | undefined;
    const clearPreview = () => {
      previewSource?.setData(EMPTY_POINTS);
      cornerSource?.setData(EMPTY_POINTS);
      setDraftBounds(null);
      setDraftScreenBox(null);
    };
    const handleDown = (event: MapMouseEvent) => {
      event.preventDefault();
      startRef.current = [event.lngLat.lng, event.lngLat.lat];
      map.dragPan.disable();
    };
    const handleMove = (event: MapMouseEvent) => {
      if (!startRef.current) return;
      const next = normalizeBounds(startRef.current, [event.lngLat.lng, event.lngLat.lat]);
      if (!next) return;
      previewSource?.setData(boundsPolygon(next));
      cornerSource?.setData(boundsCorners(next));
      setDraftBounds(next);
      setDraftScreenBox(screenBoxForBounds(map, next));
    };
    const handleUp = (event: MapMouseEvent) => {
      if (!startRef.current) return;
      const next = normalizeBounds(startRef.current, [event.lngLat.lng, event.lngLat.lat]);
      startRef.current = null;
      map.dragPan.enable();
      setDrawing(false);
      clearPreview();
      if (next) onBoundsChange(next);
    };
    map.getCanvas().style.cursor = "crosshair";
    map.on("mousedown", handleDown);
    map.on("mousemove", handleMove);
    map.on("mouseup", handleUp);
    return () => {
      map.off("mousedown", handleDown);
      map.off("mousemove", handleMove);
      map.off("mouseup", handleUp);
      map.getCanvas().style.cursor = "";
      map.dragPan.enable();
      startRef.current = null;
      clearPreview();
    };
  }, [drawing, mapReady, onBoundsChange]);

  const draftDimensions = draftBounds ? boundsDimensionsMiles(draftBounds) : null;
  const visibleScreenBox = draftScreenBox ?? committedScreenBox;
  const visibleBounds = draftBounds ?? bounds;
  const boundaryInsideCoverage = visibleBounds ? boundsContainBounds(packCoverage, visibleBounds) : true;

  return (
    <section className={drawing ? "map-shell is-drawing" : "map-shell"} aria-label="Hike search map">
      <div className="map-toolbar" aria-label="Boundary tools">
        <button
          type="button"
          className={drawing ? "active" : ""}
          aria-pressed={drawing}
          onClick={() => setDrawing(true)}
        >
          {bounds ? "Redraw boundary" : "Draw boundary"}
        </button>
        <button type="button" onClick={() => onBoundsChange([...suggestedBounds])}>
          Use demo area
        </button>
        <button type="button" disabled={!bounds} onClick={() => onBoundsChange(null)}>
          Clear
        </button>
      </div>
      <div ref={containerRef} className="map-canvas" aria-hidden="true" />
      {coverageScreenBox ? (
        <div className="coverage-screen-box" style={coverageScreenBox} aria-hidden="true">
          <span>Installed demo coverage</span>
        </div>
      ) : null}
      {visibleScreenBox ? (
        <div
          className={`${draftScreenBox ? "boundary-screen-box draft" : "boundary-screen-box committed"}${boundaryInsideCoverage ? "" : " outside-coverage"}`}
          style={visibleScreenBox}
          aria-hidden="true"
        >
          <span>{boundaryInsideCoverage ? (draftScreenBox ? "Drawing search area" : "Search boundary") : "Outside installed coverage"}</span>
          <i className="corner northwest" />
          <i className="corner northeast" />
          <i className="corner southeast" />
          <i className="corner southwest" />
        </div>
      ) : null}
      {draftDimensions ? (
        <output className="boundary-draft-readout" aria-label="Boundary dimensions">
          <strong>Search area</strong>
          <span>{draftDimensions.width.toFixed(1)} × {draftDimensions.height.toFixed(1)} mi</span>
          <small>{draftDimensions.area.toFixed(1)} sq mi · {boundaryInsideCoverage ? "inside coverage" : "outside coverage"}</small>
        </output>
      ) : null}
      <p className="map-hint">
        {drawing
          ? "Keep the orange search box entirely inside the green installed demo coverage."
          : bounds
            ? boundaryInsideCoverage
              ? "Routes may not leave the outlined boundary."
              : "Move or redraw this box entirely inside the green installed demo coverage."
            : "Draw inside the green installed demo coverage, or use the demo area."}
      </p>
    </section>
  );
}
