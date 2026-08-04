"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { normalizeGeoJson } from "./geojson";
import { parseCoordinates } from "./location-search";
import {
  REACHABILITY_DURATIONS,
  formatDuration,
  providerForDuration,
  type ReachabilityProvider,
} from "./reachability";
import {
  buildTrailAccessMarkerModels,
  formatContractValue,
  formatElevationRange,
  formatSourceDate,
  formatTrailLength,
  type ReachableTrail,
  type TrailSearchResponse,
} from "./trails/ui";

type Origin = { lat: number; lng: number; label: string };
type MapType = "terrain" | "roadmap" | "satellite";
type MapsConfigResponse = { apiKey?: string; error?: { message?: string } };
type ReachabilityResponse = {
  status?: "pending" | "complete";
  provider?: ReachabilityProvider;
  requestId?: string;
  pollAfterMs?: number;
  durationMinutes?: number;
  geoJson?: unknown;
  error?: string;
};
type CompletedReachability = { key: string; geoJson: object };

type CacheEntry =
  | {
      status: "pending";
      provider: "arcgis";
      requestId: string;
      pollAfterMs: number;
    }
  | {
      status: "complete";
      provider: ReachabilityProvider;
      geoJson: object;
    };

const BAY_AREA_CENTER = { lat: 37.7749, lng: -122.4194 };
const REQUEST_SETTLE_MS = 600;
const SEARCH_DEBOUNCE_MS = 250;
const MAX_POLL_TIME_MS = 120_000;
let mapsLoader: Promise<void> | null = null;

function loadGoogleMaps(apiKey: string): Promise<void> {
  if (typeof google !== "undefined" && google.maps) return Promise.resolve();
  if (mapsLoader) return mapsLoader;

  mapsLoader = new Promise((resolve, reject) => {
    const callbackName = "__alpineSearchMapsReady";
    const existingScript = document.querySelector<HTMLScriptElement>(
      "script[data-alpine-google-maps]",
    );
    const timeout = window.setTimeout(
      () => reject(new Error("Google Maps took too long to load.")),
      15000,
    );
    const finish = () => {
      window.clearTimeout(timeout);
      resolve();
    };
    Object.assign(window, { [callbackName]: finish });

    if (existingScript) {
      existingScript.addEventListener("error", () => {
        window.clearTimeout(timeout);
        reject(new Error("Google Maps could not be loaded."));
      });
      return;
    }

    const script = document.createElement("script");
    script.dataset.alpineGoogleMaps = "true";
    script.async = true;
    script.src =
      `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}` +
      `&libraries=places&v=weekly&loading=async&callback=${callbackName}`;
    script.onerror = () => {
      window.clearTimeout(timeout);
      mapsLoader = null;
      reject(new Error("Google Maps could not be loaded."));
    };
    document.head.appendChild(script);
  });
  return mapsLoader;
}

function clearDataLayer(map: google.maps.Map | null) {
  if (!map) return;
  map.data.forEach((feature) => map.data.remove(feature));
}

function extendBounds(coordinates: unknown, bounds: google.maps.LatLngBounds) {
  if (!Array.isArray(coordinates)) return;
  if (
    coordinates.length >= 2 &&
    typeof coordinates[0] === "number" &&
    typeof coordinates[1] === "number"
  ) {
    bounds.extend({ lat: coordinates[1], lng: coordinates[0] });
    return;
  }
  coordinates.forEach((entry) => extendBounds(entry, bounds));
}

function geoJsonBounds(geoJson: object) {
  const bounds = new google.maps.LatLngBounds();
  const candidate = geoJson as {
    type?: string;
    coordinates?: unknown;
    geometry?: { coordinates?: unknown };
    features?: Array<{ geometry?: { coordinates?: unknown } }>;
  };
  if (candidate.type === "FeatureCollection") {
    candidate.features?.forEach((feature) =>
      extendBounds(feature.geometry?.coordinates, bounds),
    );
  } else if (candidate.type === "Feature") {
    extendBounds(candidate.geometry?.coordinates, bounds);
  } else {
    extendBounds(candidate.coordinates, bounds);
  }
  return bounds;
}

function shouldFitGeoJson(map: google.maps.Map, geoJson: object) {
  const areaBounds = geoJsonBounds(geoJson);
  if (areaBounds.isEmpty()) return false;
  const viewport = map.getBounds();
  return (
    !viewport ||
    !viewport.contains(areaBounds.getNorthEast()) ||
    !viewport.contains(areaBounds.getSouthWest())
  );
}

function fitGeoJson(map: google.maps.Map, geoJson: object) {
  const bounds = geoJsonBounds(geoJson);
  if (!bounds.isEmpty()) map.fitBounds(bounds, 48);
}

function waitForPoll(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        window.clearTimeout(timeout);
        reject(new DOMException("The request was aborted.", "AbortError"));
      },
      { once: true },
    );
  });
}

function TrailSourceList({ sourceRefs }: { sourceRefs: ReachableTrail["sourceRefs"] }) {
  return (
    <ul className="trail-source-list">
      {sourceRefs.map((source) => (
        <li key={`${source.provider}:${source.sourceId}:${source.sourceUrl}`}>
          <a href={source.sourceUrl} target="_blank" rel="noreferrer">
            {source.provider}
          </a>
          <span>{source.sourceId}</span>
          <small>
            {source.sourceUpdatedAt && `Updated ${formatSourceDate(source.sourceUpdatedAt)} · `}
            Retrieved {formatSourceDate(source.retrievedAt)}
          </small>
        </li>
      ))}
    </ul>
  );
}

export function ReachabilityMap() {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const markerRef = useRef<google.maps.Marker | null>(null);
  const trailDataLayerRef = useRef<google.maps.Data | null>(null);
  const trailMarkerRefs = useRef<google.maps.Marker[]>([]);
  const autocompleteSessionRef = useRef<google.maps.places.AutocompleteSessionToken | null>(null);
  const requestIdRef = useRef(0);
  const searchRequestIdRef = useRef(0);
  const trailSearchRequestIdRef = useRef(0);
  const trailGeometryRequestIdRef = useRef(0);
  const fitNextContourRef = useRef(false);
  const shownDurationRef = useRef<number | null>(null);
  const reachabilityCacheRef = useRef(new Map<string, CacheEntry>());
  const trailGeometryCacheRef = useRef(new Map<string, object>());

  const [mapReady, setMapReady] = useState(false);
  const [origin, setOrigin] = useState<Origin | null>(null);
  const [durationIndex, setDurationIndex] = useState(
    REACHABILITY_DURATIONS.indexOf(30),
  );
  const [appliedDuration, setAppliedDuration] = useState(30);
  const [shownDuration, setShownDuration] = useState<number | null>(null);
  const [shownProvider, setShownProvider] = useState<ReachabilityProvider | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isLocating, setIsLocating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  const [usageRemaining, setUsageRemaining] = useState<number | null>(null);
  const [usageLimit, setUsageLimit] = useState<number | null>(null);
  const [usageProvider, setUsageProvider] = useState<ReachabilityProvider | null>(null);
  const [mapType, setMapType] = useState<MapType>("terrain");
  const [showReachability, setShowReachability] = useState(true);
  const [showTrails, setShowTrails] = useState(false);
  const [completedReachability, setCompletedReachability] = useState<CompletedReachability | null>(null);
  const [trailSearchResult, setTrailSearchResult] = useState<TrailSearchResponse | null>(null);
  const [trailsLoading, setTrailsLoading] = useState(false);
  const [trailsError, setTrailsError] = useState<string | null>(null);
  const [trailSearchRetryToken, setTrailSearchRetryToken] = useState(0);
  const [selectedTrailId, setSelectedTrailId] = useState<string | null>(null);
  const [trailGeometryLoading, setTrailGeometryLoading] = useState(false);
  const [trailGeometryError, setTrailGeometryError] = useState<string | null>(null);
  const [trailGeometryRetryToken, setTrailGeometryRetryToken] = useState(0);
  const [searchValue, setSearchValue] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [suggestions, setSuggestions] = useState<google.maps.places.PlacePrediction[]>([]);
  const duration = REACHABILITY_DURATIONS[durationIndex];

  const applyOverlayStyle = useCallback((map: google.maps.Map | null, visible: boolean) => {
    map?.data.setStyle({
      fillColor: "#e36d36",
      fillOpacity: 0.28,
      strokeColor: "#b9461d",
      strokeOpacity: 1,
      strokeWeight: 2,
      clickable: false,
      visible,
    });
  }, []);

  const clearTrailMarkers = useCallback(() => {
    trailMarkerRefs.current.forEach((marker) => {
      google.maps.event.clearInstanceListeners(marker);
      marker.setMap(null);
    });
    trailMarkerRefs.current = [];
  }, []);

  const clearTrailGeometry = useCallback(() => {
    trailDataLayerRef.current?.forEach((feature) => trailDataLayerRef.current?.remove(feature));
  }, []);

  const clearTrailMapLayers = useCallback(() => {
    clearTrailMarkers();
    clearTrailGeometry();
  }, [clearTrailGeometry, clearTrailMarkers]);

  useEffect(() => {
    let active = true;
    async function initializeMap() {
      try {
        const response = await fetch("/api/maps-config", {
          headers: { Accept: "application/json" },
          cache: "no-store",
        });
        const config = (await response.json()) as MapsConfigResponse;
        if (!response.ok || !config.apiKey) {
          throw new Error(
            config.error?.message ?? "Add a Google Maps browser key to start exploring.",
          );
        }
        await loadGoogleMaps(config.apiKey);
        if (!active || !mapContainerRef.current) return;

        const map = new google.maps.Map(mapContainerRef.current, {
          center: BAY_AREA_CENTER,
          zoom: 9,
          mapTypeId: google.maps.MapTypeId.TERRAIN,
          clickableIcons: false,
          streetViewControl: false,
          mapTypeControl: false,
          fullscreenControl: false,
          zoomControl: true,
          zoomControlOptions: { position: google.maps.ControlPosition.LEFT_TOP },
          gestureHandling: "greedy",
          controlSize: 30,
        });
        applyOverlayStyle(map, true);
        const trailDataLayer = new google.maps.Data({ map });
        trailDataLayer.setStyle({
          clickable: false,
          strokeColor: "#2f6b4f",
          strokeOpacity: 1,
          strokeWeight: 5,
          fillOpacity: 0,
          zIndex: 4,
        });
        mapRef.current = map;
        trailDataLayerRef.current = trailDataLayer;
        setMapReady(true);
      } catch (caught) {
        if (active) {
          setError(caught instanceof Error ? caught.message : "The map could not be loaded.");
        }
      }
    }
    void initializeMap();
    return () => {
      active = false;
      clearTrailMapLayers();
      trailDataLayerRef.current?.setMap(null);
      trailDataLayerRef.current = null;
    };
  }, [applyOverlayStyle, clearTrailMapLayers]);

  useEffect(() => {
    if (!mapRef.current) return;
    mapRef.current.setMapTypeId(mapType);
  }, [mapType]);

  useEffect(() => {
    applyOverlayStyle(mapRef.current, showReachability);
  }, [applyOverlayStyle, showReachability]);

  useEffect(() => {
    const timer = window.setTimeout(() => setAppliedDuration(duration), REQUEST_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [duration]);

  const selectOrigin = useCallback((nextOrigin: Origin) => {
    requestIdRef.current += 1;
    setOrigin(nextOrigin);
    setError(null);
    setShownDuration(null);
    shownDurationRef.current = null;
    setShownProvider(null);
    setCompletedReachability(null);
    fitNextContourRef.current = true;
    clearDataLayer(mapRef.current);
    if (mapRef.current) {
      mapRef.current.panTo(nextOrigin);
      mapRef.current.setZoom(10);
    }
  }, []);

  const clearOrigin = useCallback(() => {
    requestIdRef.current += 1;
    markerRef.current?.setMap(null);
    markerRef.current = null;
    clearDataLayer(mapRef.current);
    setOrigin(null);
    setShownDuration(null);
    shownDurationRef.current = null;
    setShownProvider(null);
    setCompletedReachability(null);
    setSearchValue("");
    setSuggestions([]);
    setError(null);
    mapRef.current?.setCenter(BAY_AREA_CENTER);
    mapRef.current?.setZoom(9);
  }, []);

  useEffect(() => {
    if (!mapReady) return;
    const input = searchValue.trim();
    if (!input || parseCoordinates(input) || input === origin?.label) {
      return;
    }

    const requestId = ++searchRequestIdRef.current;
    const timer = window.setTimeout(async () => {
      setSearchLoading(true);
      try {
        const { AutocompleteSessionToken, AutocompleteSuggestion } =
          (await google.maps.importLibrary("places")) as google.maps.PlacesLibrary;
        autocompleteSessionRef.current ??= new AutocompleteSessionToken();
        const response = await AutocompleteSuggestion.fetchAutocompleteSuggestions({
          input,
          includedRegionCodes: ["us"],
          locationBias: { center: BAY_AREA_CENTER, radius: 50000 },
          sessionToken: autocompleteSessionRef.current,
        });
        if (requestId !== searchRequestIdRef.current) return;
        setSuggestions(
          response.suggestions
            .map((suggestion) => suggestion.placePrediction)
            .filter((prediction): prediction is google.maps.places.PlacePrediction =>
              Boolean(prediction),
            )
            .slice(0, 6),
        );
      } catch {
        if (requestId === searchRequestIdRef.current) {
          setSuggestions([]);
          setError("Location suggestions could not be loaded. Try coordinates instead.");
        }
      } finally {
        if (requestId === searchRequestIdRef.current) setSearchLoading(false);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [mapReady, origin?.label, searchValue]);

  const selectPrediction = async (prediction: google.maps.places.PlacePrediction) => {
    setSearchLoading(true);
    setSuggestions([]);
    try {
      const place = prediction.toPlace();
      await place.fetchFields({
        fields: ["displayName", "formattedAddress", "location"],
      });
      if (!place.location) throw new Error("That place does not have a map location.");
      const label = place.formattedAddress ?? place.displayName ?? prediction.text.toString();
      setSearchValue(label);
      setSearchFocused(false);
      searchInputRef.current?.blur();
      selectOrigin({ lat: place.location.lat(), lng: place.location.lng(), label });
      autocompleteSessionRef.current = null;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That location could not be selected.");
    } finally {
      setSearchLoading(false);
    }
  };

  const selectTypedCoordinates = () => {
    const coordinates = parseCoordinates(searchValue);
    if (!coordinates) return;
    const label = `${coordinates.lat.toFixed(5)}, ${coordinates.lng.toFixed(5)}`;
    setSearchValue(label);
    setSuggestions([]);
    setSearchFocused(false);
    searchInputRef.current?.blur();
    selectOrigin({ ...coordinates, label });
  };

  useEffect(() => {
    markerRef.current?.setMap(null);
    markerRef.current = null;
    if (!origin || !mapRef.current) return;
    markerRef.current = new google.maps.Marker({
      map: mapRef.current,
      position: origin,
      title: origin.label,
      zIndex: 5,
    });
  }, [origin]);

  useEffect(() => {
    if (!origin || !mapReady) return;
    const controller = new AbortController();
    const requestId = ++requestIdRef.current;
    const cacheKey = `${origin.lat.toFixed(5)}:${origin.lng.toFixed(5)}:${appliedDuration}`;

    const updateUsage = (response: Response) => {
      const remainingHeader = response.headers.get("X-RateLimit-Remaining");
      const limitHeader = response.headers.get("X-RateLimit-Limit");
      const provider = response.headers.get("X-Reachability-Provider");
      const remaining = remainingHeader === null ? Number.NaN : Number(remainingHeader);
      const limit = limitHeader === null ? Number.NaN : Number(limitHeader);
      if (Number.isFinite(remaining) && Number.isFinite(limit)) {
        setUsageRemaining(remaining);
        setUsageLimit(limit);
        if (provider === "google" || provider === "arcgis") setUsageProvider(provider);
      }
    };

    const showResult = (entry: Extract<CacheEntry, { status: "complete" }>) => {
      if (requestId !== requestIdRef.current || !mapRef.current) return;
      const previousDuration = shownDurationRef.current;
      clearDataLayer(mapRef.current);
      mapRef.current.data.addGeoJson(entry.geoJson);
      applyOverlayStyle(mapRef.current, showReachability);
      if (
        fitNextContourRef.current ||
        (previousDuration !== null &&
          appliedDuration > previousDuration &&
          shouldFitGeoJson(mapRef.current, entry.geoJson))
      ) {
        fitGeoJson(mapRef.current, entry.geoJson);
        fitNextContourRef.current = false;
      }
      shownDurationRef.current = appliedDuration;
      setShownDuration(appliedDuration);
      setShownProvider(entry.provider);
      setCompletedReachability((current) =>
        current?.key === cacheKey ? current : { key: cacheKey, geoJson: entry.geoJson },
      );
    };

    const poll = async (entry: Extract<CacheEntry, { status: "pending" }>) => {
      const startedAt = Date.now();
      let pollAfterMs = entry.pollAfterMs;
      while (Date.now() - startedAt < MAX_POLL_TIME_MS) {
        await waitForPoll(pollAfterMs, controller.signal);
        const response = await fetch(
          `/api/reachability/${encodeURIComponent(entry.requestId)}`,
          { headers: { Accept: "application/json" }, signal: controller.signal, cache: "no-store" },
        );
        updateUsage(response);
        const payload = (await response.json()) as ReachabilityResponse;
        if (response.status === 202 && payload.status === "pending") {
          pollAfterMs = Math.min(5_000, Math.max(2_000, payload.pollAfterMs ?? pollAfterMs + 1_000));
          reachabilityCacheRef.current.set(cacheKey, {
            ...entry,
            pollAfterMs,
          });
          continue;
        }
        const geoJson = normalizeGeoJson(payload.geoJson);
        if (!response.ok || payload.status !== "complete" || !geoJson) {
          throw new Error(payload.error ?? "That long-range area could not be calculated.");
        }
        const complete: CacheEntry = {
          status: "complete",
          provider: payload.provider ?? "arcgis",
          geoJson,
        };
        reachabilityCacheRef.current.set(cacheKey, complete);
        showResult(complete);
        return;
      }
      throw new Error("This long-range area is still building. Retry to keep waiting without starting over.");
    };

    const run = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const cached = reachabilityCacheRef.current.get(cacheKey);
        if (cached?.status === "complete") {
          showResult(cached);
          return;
        }
        if (cached?.status === "pending") {
          await poll(cached);
          return;
        }

        const response = await fetch("/api/reachability", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            latitude: origin.lat,
            longitude: origin.lng,
            durationMinutes: appliedDuration,
          }),
          signal: controller.signal,
          cache: "no-store",
        });
        updateUsage(response);
        const payload = (await response.json()) as ReachabilityResponse;
        if (response.status === 202 && payload.status === "pending" && payload.requestId) {
          const pending: CacheEntry = {
            status: "pending",
            provider: "arcgis",
            requestId: payload.requestId,
            pollAfterMs: payload.pollAfterMs ?? 2_000,
          };
          reachabilityCacheRef.current.set(cacheKey, pending);
          await poll(pending);
          return;
        }
        const geoJson = normalizeGeoJson(payload.geoJson);
        if (!response.ok || payload.status !== "complete" || !geoJson) {
          throw new Error(payload.error ?? "That reachability area could not be calculated.");
        }
        const complete: CacheEntry = {
          status: "complete",
          provider: payload.provider ?? providerForDuration(appliedDuration),
          geoJson,
        };
        reachabilityCacheRef.current.set(cacheKey, complete);
        showResult(complete);
      } catch (caught) {
        if (controller.signal.aborted || requestId !== requestIdRef.current) return;
        setError(
          caught instanceof Error
            ? caught.message
            : "That reachability area could not be calculated.",
        );
      } finally {
        if (requestId === requestIdRef.current) setIsLoading(false);
      }
    };
    void run();
    return () => {
      controller.abort();
    };
  }, [applyOverlayStyle, appliedDuration, mapReady, origin, retryToken, showReachability]);

  useEffect(() => {
    const requestId = ++trailSearchRequestIdRef.current;
    trailGeometryRequestIdRef.current += 1;
    const controller = new AbortController();
    const run = async () => {
      clearTrailMapLayers();
      setSelectedTrailId(null);
      setTrailGeometryLoading(false);
      setTrailGeometryError(null);
      setTrailSearchResult(null);
      setTrailsError(null);
      if (!showTrails || !completedReachability) {
        setTrailsLoading(false);
        return;
      }
      setTrailsLoading(true);
      try {
        const response = await fetch("/api/trails/search", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            regionId: "yosemite-stanislaus",
            driveTimePolygon: completedReachability.geoJson,
          }),
          signal: controller.signal,
          cache: "no-store",
        });
        const payload = (await response.json()) as Partial<TrailSearchResponse> & { error?: string };
        if (
          !response.ok ||
          payload.schemaVersion !== 1 ||
          typeof payload.count !== "number" ||
          !Array.isArray(payload.trails)
        ) {
          throw new Error(payload.error ?? "Reachable hiking trails could not be loaded.");
        }
        if (controller.signal.aborted || requestId !== trailSearchRequestIdRef.current) return;
        setTrailSearchResult(payload as TrailSearchResponse);
      } catch (caught) {
        if (controller.signal.aborted || requestId !== trailSearchRequestIdRef.current) return;
        setTrailsError(
          caught instanceof Error ? caught.message : "Reachable hiking trails could not be loaded.",
        );
      } finally {
        if (requestId === trailSearchRequestIdRef.current) setTrailsLoading(false);
      }
    };
    void run();
    return () => controller.abort();
  }, [clearTrailMapLayers, completedReachability, showTrails, trailSearchRetryToken]);

  useEffect(() => {
    clearTrailMarkers();
    if (!showTrails || !mapRef.current || !trailSearchResult) return;

    trailMarkerRefs.current = buildTrailAccessMarkerModels(
      trailSearchResult.trails,
      selectedTrailId,
    ).map((accessPoint) => {
      const marker = new google.maps.Marker({
        map: mapRef.current,
        position: { lat: accessPoint.latitude, lng: accessPoint.longitude },
        title: `${accessPoint.name ?? accessPoint.trailNames.join(", ")} — ${formatContractValue(accessPoint.confidence)} ${formatContractValue(accessPoint.type)}`,
        zIndex: accessPoint.selected ? 12 : 8,
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: accessPoint.selected ? 8 : 6,
          fillColor: accessPoint.selected ? "#efaa3c" : "#365e4c",
          fillOpacity: 1,
          strokeColor: "#ffffff",
          strokeOpacity: 1,
          strokeWeight: accessPoint.selected ? 3 : 2,
        },
      });
      marker.addListener("click", () => {
        setSelectedTrailId(
          accessPoint.selected && selectedTrailId
            ? selectedTrailId
            : accessPoint.trailIds[0],
        );
      });
      return marker;
    });

    return clearTrailMarkers;
  }, [clearTrailMarkers, selectedTrailId, showTrails, trailSearchResult]);

  useEffect(() => {
    const requestId = ++trailGeometryRequestIdRef.current;
    const controller = new AbortController();
    const run = async () => {
      clearTrailGeometry();
      setTrailGeometryLoading(false);
      setTrailGeometryError(null);
      if (!showTrails || !selectedTrailId || !trailSearchResult) return;

      const selectedTrail = trailSearchResult.trails.find(({ id }) => id === selectedTrailId);
      if (!selectedTrail) return;
      const cacheKey = `${trailSearchResult.artifactVersion}:${selectedTrail.geometryUrl}`;
      const cached = trailGeometryCacheRef.current.get(cacheKey);
      if (cached) {
        trailDataLayerRef.current?.addGeoJson(cached);
        return;
      }

      setTrailGeometryLoading(true);
      try {
        const response = await fetch(selectedTrail.geometryUrl, {
          headers: { Accept: "application/geo+json, application/json" },
          signal: controller.signal,
        });
        const payload = await response.json() as unknown;
        const geoJson = normalizeGeoJson(payload);
        const errorMessage = payload && typeof payload === "object" && "error" in payload &&
          typeof payload.error === "string" ? payload.error : undefined;
        if (!response.ok || !geoJson) {
          throw new Error(errorMessage ?? "The selected trail geometry could not be loaded.");
        }
        if (controller.signal.aborted || requestId !== trailGeometryRequestIdRef.current) return;
        trailGeometryCacheRef.current.set(cacheKey, geoJson);
        trailDataLayerRef.current?.addGeoJson(geoJson);
      } catch (caught) {
        if (controller.signal.aborted || requestId !== trailGeometryRequestIdRef.current) return;
        setTrailGeometryError(
          caught instanceof Error ? caught.message : "The selected trail geometry could not be loaded.",
        );
      } finally {
        if (requestId === trailGeometryRequestIdRef.current) setTrailGeometryLoading(false);
      }
    };
    void run();
    return () => controller.abort();
  }, [
    clearTrailGeometry,
    selectedTrailId,
    showTrails,
    trailGeometryRetryToken,
    trailSearchResult,
  ]);

  const useCurrentLocation = () => {
    if (!navigator.geolocation) {
      setError("Location is not available in this browser. Use search instead.");
      return;
    }
    setIsLocating(true);
    setError(null);
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        setIsLocating(false);
        selectOrigin({ lat: coords.latitude, lng: coords.longitude, label: "Current location" });
      },
      (locationError) => {
        setIsLocating(false);
        setError(
          locationError.code === locationError.PERMISSION_DENIED
            ? "Location access was denied. Search for an address instead."
            : "Your location could not be found. Try search instead.",
        );
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
    );
  };

  const statusMessage = error
    ? error
    : isLoading
      ? appliedDuration > 60
        ? `Building ${formatDuration(appliedDuration)} long-range drive area… This can take a couple of minutes.`
        : `Calculating the ${formatDuration(appliedDuration)} drive area…`
      : shownDuration
        ? `${formatDuration(shownDuration)} outbound drive area is active.`
        : origin
          ? "Adjust the travel time to recalculate the area."
          : "Search or use your location to create a drive-time area.";
  const selectedTrail = trailSearchResult?.trails.find(({ id }) => id === selectedTrailId);
  const activeLayerCount = 1 + Number(showReachability) + Number(showTrails);

  return (
    <main className="map-workspace">
      <header className="workspace-bar">
        <div className="workspace-brand">
          <span className="compass-mark" aria-hidden="true"><i /></span>
          <strong>ALPINE</strong><span>SEARCH</span>
        </div>
        <div
          className="workspace-search"
          onFocus={() => setSearchFocused(true)}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setSearchFocused(false);
          }}
        >
          <span className="search-icon" aria-hidden="true">⌕</span>
          <input
            ref={searchInputRef}
            type="search"
            value={searchValue}
            placeholder="Enter coordinates or a location name"
            aria-label="Search for a starting location"
            role="combobox"
            aria-autocomplete="list"
            aria-controls="location-suggestions"
            aria-expanded={searchFocused && (Boolean(parseCoordinates(searchValue)) || suggestions.length > 0)}
            autoComplete="off"
            disabled={!mapReady}
            onChange={(event) => {
              searchRequestIdRef.current += 1;
              setSearchValue(event.target.value);
              setSuggestions([]);
              setSearchLoading(false);
              setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && parseCoordinates(searchValue)) {
                event.preventDefault();
                selectTypedCoordinates();
              } else if (event.key === "Escape") {
                setSuggestions([]);
              }
            }}
          />
          {searchLoading && <span className="search-spinner" aria-label="Loading suggestions" />}
          {searchFocused && (parseCoordinates(searchValue) || suggestions.length > 0) && (
            <div className="search-suggestions" id="location-suggestions" role="listbox">
              {parseCoordinates(searchValue) && (
                <button
                  type="button"
                  role="option"
                  aria-selected="false"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={selectTypedCoordinates}
                >
                  <strong>Use these coordinates</strong>
                  <small>{searchValue.trim()}</small>
                </button>
              )}
              {suggestions.map((prediction) => (
                <button
                  type="button"
                  role="option"
                  aria-selected="false"
                  key={prediction.placeId}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => void selectPrediction(prediction)}
                >
                  <strong>{prediction.mainText?.text ?? prediction.text.toString()}</strong>
                  {prediction.secondaryText?.text && <small>{prediction.secondaryText.text}</small>}
                </button>
              ))}
            </div>
          )}
        </div>
        <nav className="workspace-tools" aria-label="Map utilities">
          <button type="button" onClick={useCurrentLocation} disabled={isLocating || !mapReady}>
            <span aria-hidden="true">◎</span>{isLocating ? "Locating" : "Locate"}
          </button>
          <button type="button" onClick={clearOrigin} disabled={!origin}>
            <span aria-hidden="true">×</span>Clear
          </button>
          <span className="workspace-mode">Drive planner</span>
        </nav>
      </header>

      <aside className="objects-panel" aria-label="Drive area controls">
        <div className="panel-heading"><strong>Drive Area</strong><span>⌃</span></div>

        <section className="object-card object-card--active">
          <div className="object-card-title">
            <span className="contour-swatch" aria-hidden="true" />
            <div><strong>Drive-time area</strong><small>Outbound · traffic-free</small></div>
            <button type="button" className="icon-button" onClick={clearOrigin} aria-label="Remove drive-time area">×</button>
          </div>

          <div className="object-field">
            <span className="field-caption">Starting point</span>
            <p>{origin?.label ?? "No location selected"}</p>
            <button type="button" className="text-button" onClick={useCurrentLocation} disabled={isLocating || !mapReady}>
              ◎ {isLocating ? "Finding location…" : "Use my current location"}
            </button>
          </div>

          <div className="object-field">
            <div className="slider-heading">
              <label htmlFor="travel-time">Travel time</label>
              <output htmlFor="travel-time">{formatDuration(duration)}</output>
            </div>
            <input
              id="travel-time"
              type="range"
              min="0"
              max={REACHABILITY_DURATIONS.length - 1}
              step="1"
              value={durationIndex}
              onChange={(event) => setDurationIndex(Number(event.target.value))}
              disabled={!origin}
              aria-valuetext={formatDuration(duration)}
            />
            <div className="slider-scale" aria-hidden="true">
              <span>5m</span><span>1h</span><span>3h</span><span>5h</span>
            </div>
          </div>

          <div className={`object-status${error ? " object-status--error" : ""}`} role="status" aria-live="polite">
            <span className={isLoading ? "status-pulse" : "status-dot"} aria-hidden="true" />
            <p>{statusMessage}</p>
            {error && origin && <button type="button" onClick={() => setRetryToken((value) => value + 1)}>Retry</button>}
          </div>
          {duration > 60 && (
            <p className="range-caveat">
              Long-range overview—mountain-road edges can be imprecise. Verify a destination before traveling.
            </p>
          )}
        </section>

        <section className="compact-layers" aria-label="Map layers">
          <div className="subsection-heading"><strong>Map Layers</strong><span>{activeLayerCount} active</span></div>
          <div className="base-layer-preview">
            <span className={`base-thumb base-thumb--${mapType}`} aria-hidden="true" />
            <div><small>Base layer</small><strong>{mapType === "terrain" ? "Topo Terrain" : mapType === "roadmap" ? "Road Map" : "Satellite"}</strong></div>
          </div>
          <div className="layer-segment" role="group" aria-label="Base map style">
            {(["terrain", "roadmap", "satellite"] as MapType[]).map((type) => (
              <button key={type} type="button" className={mapType === type ? "is-active" : ""} onClick={() => setMapType(type)}>
                {type === "terrain" ? "Topo" : type === "roadmap" ? "Road" : "Sat"}
              </button>
            ))}
          </div>
          <label className="layer-row layer-row--active reachability-layer-row">
            <input type="checkbox" checked={showReachability} onChange={(event) => setShowReachability(event.target.checked)} />
            <span className="layer-symbol layer-symbol--area" aria-hidden="true" />
            <span><strong>Drive-time area</strong><small>{formatDuration(duration)} contour</small></span>
          </label>
          <label className={`layer-row trails-layer-row${showTrails ? " layer-row--active" : ""}`}>
            <input
              type="checkbox"
              checked={showTrails}
              onChange={(event) => setShowTrails(event.target.checked)}
              aria-describedby="trails-layer-description"
            />
            <span className="layer-symbol layer-symbol--trails" aria-hidden="true" />
            <span>
              <strong>Hiking trails</strong>
              <small id="trails-layer-description">Reachable connected access</small>
            </span>
          </label>
          <div className="layer-row terrain-layer-row">
            <span className="fake-check" aria-hidden="true">✓</span><span className="layer-symbol layer-symbol--terrain" aria-hidden="true" />
            <span><strong>Terrain relief</strong><small>Hillshade and elevation</small></span>
          </div>
        </section>

        {showTrails && (
          <section className="trails-panel" aria-label="Reachable hiking trails">
            <div className="trails-panel-heading">
              <div>
                <strong>Reachable trails</strong>
                <small>Yosemite–Stanislaus</small>
              </div>
              <output
                aria-live="polite"
                aria-label={trailSearchResult ? `${trailSearchResult.count} total reachable trails` : "Reachable trail count pending"}
              >
                {trailsLoading ? "…" : trailSearchResult ? trailSearchResult.count.toLocaleString() : "—"}
              </output>
            </div>

            {!completedReachability && (
              <p className="trails-state">Create a completed drive-time area to find reachable trail access.</p>
            )}
            {trailsLoading && (
              <p className="trails-state" role="status">
                <span className="status-pulse" aria-hidden="true" /> Searching connected trail access…
              </p>
            )}
            {trailsError && (
              <div className="trails-state trails-state--error" role="alert">
                <p>{trailsError}</p>
                <button type="button" onClick={() => setTrailSearchRetryToken((value) => value + 1)}>
                  Retry
                </button>
              </div>
            )}
            {trailSearchResult && trailSearchResult.count === 0 && (
              <p className="trails-state">No hiking trails have a connected access point inside this drive-time area.</p>
            )}
            {trailSearchResult && trailSearchResult.trails.length > 0 && (
              <>
                {trailSearchResult.trails.length < trailSearchResult.count && (
                  <p className="trails-result-limit">
                    Showing {trailSearchResult.trails.length.toLocaleString()} of {trailSearchResult.count.toLocaleString()}
                  </p>
                )}
                <ol className="trail-results-list">
                  {trailSearchResult.trails.map((trail) => {
                    const isSelected = trail.id === selectedTrailId;
                    return (
                      <li key={trail.id} className={isSelected ? "is-selected" : ""}>
                        <button
                          type="button"
                          className="trail-result-select"
                          onClick={() => setSelectedTrailId(trail.id)}
                          aria-pressed={isSelected}
                          aria-label={`Show ${trail.name} on the map`}
                        >
                          <span className="trail-result-title">
                            <strong>{trail.name}</strong>
                            {trail.manager && <small>{trail.manager}</small>}
                          </span>
                          <span className="trail-result-metrics">
                            <span><small>Length</small>{formatTrailLength(trail.lengthMeters)}</span>
                            <span><small>Elevation</small>{formatElevationRange(trail.elevation)}</span>
                          </span>
                        </button>

                        {isSelected && (
                          <div className="trail-result-details">
                            <dl>
                              <div><dt>Hiking</dt><dd>{formatContractValue(trail.hiking)}</dd></div>
                              <div><dt>Access</dt><dd>{formatContractValue(trail.access)}</dd></div>
                              <div><dt>Status</dt><dd>{formatContractValue(trail.status)}</dd></div>
                              <div><dt>Surface</dt><dd>{trail.surfaces?.join(", ") || "Unavailable"}</dd></div>
                            </dl>

                            <div className="trail-access-summary">
                              <strong>Reachable access</strong>
                              <ul>
                                {trail.accessPoints.map((accessPoint) => (
                                  <li key={accessPoint.id}>
                                    <span>{accessPoint.name ?? formatContractValue(accessPoint.type)}</span>
                                    <small>{formatContractValue(accessPoint.type)} · {formatContractValue(accessPoint.confidence)} confidence</small>
                                  </li>
                                ))}
                              </ul>
                            </div>

                            {trail.notices.length > 0 && (
                              <ul className="trail-notices" aria-label="Trail notices">
                                {trail.notices.map((notice) => <li key={notice}>{notice}</li>)}
                              </ul>
                            )}

                            <details className="trail-sources">
                              <summary>Source and update details</summary>
                              <TrailSourceList sourceRefs={trail.sourceRefs} />
                              {trail.accessPoints.map((accessPoint) => (
                                <div className="trail-access-sources" key={accessPoint.id}>
                                  <strong>{accessPoint.name ?? formatContractValue(accessPoint.type)} access sources</strong>
                                  <TrailSourceList sourceRefs={accessPoint.sourceRefs} />
                                </div>
                              ))}
                            </details>

                            {trailGeometryLoading && <p className="trail-geometry-state" role="status">Loading trail geometry…</p>}
                            {trailGeometryError && (
                              <div className="trail-geometry-state trail-geometry-state--error" role="alert">
                                <span>{trailGeometryError}</span>
                                <button type="button" onClick={() => setTrailGeometryRetryToken((value) => value + 1)}>Retry geometry</button>
                              </div>
                            )}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ol>
              </>
            )}
          </section>
        )}

        <div className="panel-spacer" />

        <footer className="objects-footer">
          <strong>Usage</strong>
          <span>{usageRemaining !== null && usageLimit !== null ? `${usageProvider === "arcgis" ? "Long" : "Short"}: ${usageRemaining.toLocaleString()} / ${usageLimit.toLocaleString()} left` : "Protected monthly limit"}</span>
        </footer>
      </aside>

      <section className="map-stage" aria-label="Reachability map workspace">
        <div ref={mapContainerRef} className="map-canvas" role="region" aria-label="Bay Area reachability map" />
        {!mapReady && (
          <div className="map-loading" aria-hidden="true"><div className="terrain-rings" /><span>Loading topo map</span></div>
        )}
        <div className="coordinate-readout">
          <strong>{origin ? `${origin.lat.toFixed(5)}, ${origin.lng.toFixed(5)}` : "37.77490, -122.41940"}</strong>
          <span>{origin ? "Selected origin" : "Bay Area · WGS84"}</span>
        </div>
        <div className="map-legend" aria-hidden="true">
          <span /> {formatDuration(shownDuration ?? duration)} drive area
          {shownProvider === "arcgis" && <small>Long-range</small>}
          {selectedTrail && <><i /> {selectedTrail.name}</>}
        </div>
      </section>

    </main>
  );
}
