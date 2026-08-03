"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Origin = { lat: number; lng: number; label: string };
type MapType = "terrain" | "roadmap" | "satellite";
type MapsConfigResponse = { apiKey?: string; error?: { message?: string } };
type IsochroneResponse = {
  isochrone?: { geoJson?: object };
  error?: string;
};
type PlaceSelectEvent = Event & {
  placePrediction?: { toPlace(): google.maps.places.Place };
};

const BAY_AREA_CENTER = { lat: 37.7749, lng: -122.4194 };
const REQUEST_DEBOUNCE_MS = 350;
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

function fitGeoJson(map: google.maps.Map, geoJson: object) {
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
  if (!bounds.isEmpty()) map.fitBounds(bounds, 48);
}

export function ReachabilityMap() {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const autocompleteContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const markerRef = useRef<google.maps.Marker | null>(null);
  const requestIdRef = useRef(0);
  const fitNextContourRef = useRef(false);

  const [mapReady, setMapReady] = useState(false);
  const [origin, setOrigin] = useState<Origin | null>(null);
  const [duration, setDuration] = useState(30);
  const [shownDuration, setShownDuration] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isLocating, setIsLocating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  const [usageRemaining, setUsageRemaining] = useState<number | null>(null);
  const [usageLimit, setUsageLimit] = useState<number | null>(null);
  const [mapType, setMapType] = useState<MapType>("terrain");
  const [showReachability, setShowReachability] = useState(true);

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
        mapRef.current = map;
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
    };
  }, [applyOverlayStyle]);

  useEffect(() => {
    if (!mapRef.current) return;
    mapRef.current.setMapTypeId(mapType);
  }, [mapType]);

  useEffect(() => {
    applyOverlayStyle(mapRef.current, showReachability);
  }, [applyOverlayStyle, showReachability]);

  const selectOrigin = useCallback((nextOrigin: Origin) => {
    setOrigin(nextOrigin);
    setError(null);
    setShownDuration(null);
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
    setError(null);
    mapRef.current?.setCenter(BAY_AREA_CENTER);
    mapRef.current?.setZoom(9);
  }, []);

  useEffect(() => {
    if (!mapReady || !autocompleteContainerRef.current) return;
    const element = new google.maps.places.PlaceAutocompleteElement({
      componentRestrictions: { country: "us" },
      locationBias: { center: BAY_AREA_CENTER, radius: 160000 },
    });
    element.setAttribute("placeholder", "Enter coordinates or a location name");
    element.setAttribute("aria-label", "Search for a starting location");

    const handleSelect = async (event: Event) => {
      const prediction = (event as PlaceSelectEvent).placePrediction;
      if (!prediction) return;
      try {
        const place = prediction.toPlace();
        await place.fetchFields({
          fields: ["displayName", "formattedAddress", "location"],
        });
        if (!place.location) throw new Error("That place does not have a map location.");
        selectOrigin({
          lat: place.location.lat(),
          lng: place.location.lng(),
          label: place.formattedAddress ?? place.displayName ?? "Selected location",
        });
      } catch (caught) {
        setError(
          caught instanceof Error ? caught.message : "That location could not be selected.",
        );
      }
    };

    element.addEventListener("gmp-select", handleSelect);
    autocompleteContainerRef.current.replaceChildren(element);
    return () => {
      element.removeEventListener("gmp-select", handleSelect);
      element.remove();
    };
  }, [mapReady, selectOrigin]);

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
    const timer = window.setTimeout(async () => {
      setIsLoading(true);
      setError(null);
      try {
        const response = await fetch("/api/isochrones", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            latitude: origin.lat,
            longitude: origin.lng,
            durationMinutes: duration,
          }),
          signal: controller.signal,
          cache: "no-store",
        });
        const payload = (await response.json()) as IsochroneResponse;
        const geoJson = payload.isochrone?.geoJson;
        if (!response.ok || !geoJson) {
          throw new Error(payload.error ?? "That reachability area could not be calculated.");
        }
        if (requestId !== requestIdRef.current || !mapRef.current) return;
        clearDataLayer(mapRef.current);
        mapRef.current.data.addGeoJson(geoJson);
        applyOverlayStyle(mapRef.current, showReachability);
        if (fitNextContourRef.current) {
          fitGeoJson(mapRef.current, geoJson);
          fitNextContourRef.current = false;
        }
        setShownDuration(duration);
        const remaining = Number(response.headers.get("X-RateLimit-Remaining"));
        const limit = Number(response.headers.get("X-RateLimit-Limit"));
        if (Number.isFinite(remaining) && Number.isFinite(limit)) {
          setUsageRemaining(remaining);
          setUsageLimit(limit);
        }
      } catch (caught) {
        if (controller.signal.aborted || requestId !== requestIdRef.current) return;
        clearDataLayer(mapRef.current);
        setShownDuration(null);
        setError(
          caught instanceof Error
            ? caught.message
            : "That reachability area could not be calculated.",
        );
      } finally {
        if (requestId === requestIdRef.current) setIsLoading(false);
      }
    }, REQUEST_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [applyOverlayStyle, duration, mapReady, origin, retryToken, showReachability]);

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
      ? `Calculating the ${duration}-minute drive area…`
      : shownDuration
        ? `${shownDuration}-minute outbound drive area is active.`
        : origin
          ? "Adjust the travel time to recalculate the area."
          : "Search or use your location to create a drive-time area.";

  return (
    <main className="map-workspace">
      <header className="workspace-bar">
        <div className="workspace-brand">
          <span className="compass-mark" aria-hidden="true"><i /></span>
          <strong>ALPINE</strong><span>SEARCH</span>
        </div>
        <div className="workspace-search" ref={autocompleteContainerRef} aria-live="polite">
          {!mapReady && <div className="search-placeholder">Enter coordinates or a location name</div>}
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
              <output htmlFor="travel-time">{duration} min</output>
            </div>
            <input
              id="travel-time"
              type="range"
              min="5"
              max="60"
              step="5"
              value={duration}
              onChange={(event) => setDuration(Number(event.target.value))}
              disabled={!origin}
              aria-valuetext={`${duration} minutes`}
            />
            <div className="slider-scale" aria-hidden="true"><span>5</span><span>30</span><span>60</span></div>
          </div>

          <div className={`object-status${error ? " object-status--error" : ""}`} role="status" aria-live="polite">
            <span className={isLoading ? "status-pulse" : "status-dot"} aria-hidden="true" />
            <p>{statusMessage}</p>
            {error && origin && <button type="button" onClick={() => setRetryToken((value) => value + 1)}>Retry</button>}
          </div>
        </section>

        <section className="compact-layers" aria-label="Map layers">
          <div className="subsection-heading"><strong>Map Layers</strong><span>{showReachability ? "2 active" : "1 active"}</span></div>
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
          <label className="layer-row layer-row--active">
            <input type="checkbox" checked={showReachability} onChange={(event) => setShowReachability(event.target.checked)} />
            <span className="layer-symbol layer-symbol--area" aria-hidden="true" />
            <span><strong>Drive-time area</strong><small>{duration} minute contour</small></span>
          </label>
          <div className="layer-row">
            <span className="fake-check" aria-hidden="true">✓</span><span className="layer-symbol layer-symbol--terrain" aria-hidden="true" />
            <span><strong>Terrain relief</strong><small>Hillshade and elevation</small></span>
          </div>
        </section>

        <div className="panel-spacer" />

        <footer className="objects-footer">
          <strong>Usage</strong>
          <span>{usageRemaining !== null && usageLimit !== null ? `${usageRemaining.toLocaleString()} / ${usageLimit.toLocaleString()} calls left` : "Protected monthly limit"}</span>
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
        <div className="map-legend" aria-hidden="true"><span /> {shownDuration ?? duration} min drive area</div>
      </section>

    </main>
  );
}
