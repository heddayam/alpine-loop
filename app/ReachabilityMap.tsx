"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Origin = { lat: number; lng: number; label: string };
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
  if (!bounds.isEmpty()) map.fitBounds(bounds, 72);
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
          fullscreenControl: true,
          zoomControl: true,
          gestureHandling: "greedy",
          controlSize: 34,
        });
        map.data.setStyle({
          fillColor: "#e4622e",
          fillOpacity: 0.24,
          strokeColor: "#c44920",
          strokeOpacity: 0.95,
          strokeWeight: 2,
          clickable: false,
        });
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
  }, []);

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

  useEffect(() => {
    if (!mapReady || !autocompleteContainerRef.current) return;
    const element = new google.maps.places.PlaceAutocompleteElement({
      componentRestrictions: { country: "us" },
      locationBias: { center: BAY_AREA_CENTER, radius: 160000 },
    });
    element.setAttribute("placeholder", "Search an address or place");
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
          throw new Error(
            payload.error ?? "That reachability area could not be calculated.",
          );
        }
        if (requestId !== requestIdRef.current || !mapRef.current) return;
        clearDataLayer(mapRef.current);
        mapRef.current.data.addGeoJson(geoJson);
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
  }, [duration, mapReady, origin, retryToken]);

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
      ? `Mapping the ${duration}-minute drive area…`
      : shownDuration
        ? `Showing the area reachable within ${shownDuration} minutes.`
        : origin
          ? "Adjust the travel time to explore farther."
          : "Choose a starting point to draw your reachability area.";

  return (
    <main className="map-shell">
      <div ref={mapContainerRef} className="map-canvas" role="region" aria-label="Bay Area reachability map" />
      {!mapReady && (
        <div className="map-loading" aria-hidden="true">
          <div className="terrain-rings" />
          <span>Loading terrain</span>
        </div>
      )}

      <section className="control-panel" aria-label="Reachability controls">
        <header className="brand-row">
          <div className="brand-mark" aria-hidden="true"><span /><span /><span /></div>
          <div><p className="eyebrow">Bay Area field tool</p><h1>Alpine Search</h1></div>
          <span className="mode-badge">Drive</span>
        </header>

        <div className="panel-section location-section">
          <label className="field-label">Starting point</label>
          <div ref={autocompleteContainerRef} className="autocomplete-host" aria-live="polite">
            {!mapReady && <div className="search-placeholder">Loading search…</div>}
          </div>
          <button type="button" className="location-button" onClick={useCurrentLocation} disabled={isLocating || !mapReady}>
            <span className="location-dot" aria-hidden="true" />
            {isLocating ? "Finding your location…" : "Use my current location"}
          </button>
          {origin && <p className="origin-label">From: {origin.label}</p>}
        </div>

        <div className="panel-section time-section">
          <div className="slider-heading">
            <label htmlFor="travel-time">Travel time</label>
            <output htmlFor="travel-time">{duration} min</output>
          </div>
          <input id="travel-time" type="range" min="5" max="60" step="5" value={duration} onChange={(event) => setDuration(Number(event.target.value))} disabled={!origin} aria-valuetext={`${duration} minutes`} />
          <div className="slider-scale" aria-hidden="true"><span>5</span><span>15</span><span>30</span><span>45</span><span>60 min</span></div>
        </div>

        <div className={`status-card${error ? " status-card--error" : ""}`} role="status" aria-live="polite">
          <span className="status-indicator" aria-hidden="true" />
          <p>{statusMessage}</p>
          {error && origin && <button type="button" onClick={() => setRetryToken((value) => value + 1)}>Retry</button>}
        </div>

        <footer className="panel-footer">
          <span>Traffic-free baseline</span><span aria-hidden="true">·</span><span>Outbound drive</span>
          {usageRemaining !== null && usageLimit !== null && (
            <span className="usage-budget">{usageRemaining.toLocaleString()} of {usageLimit.toLocaleString()} free calls left</span>
          )}
        </footer>
      </section>

      <div className="map-legend" aria-hidden="true"><span /> Reachable area</div>
    </main>
  );
}
