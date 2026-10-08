import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Popup, type Map as MapLibreMap, type MapMouseEvent } from "maplibre-gl";

export function MapCoordinates({ map }: { map: MapLibreMap | null }) {
  const [position, setPosition] = useState<{ lng: number; lat: number } | null>(null);
  const [feedback, setFeedback] = useState("");
  const [content] = useState(() => document.createElement("div"));
  const latestPosition = useRef(position);
  latestPosition.current = position;

  useEffect(() => {
    if (feedback !== "Copied") return;
    const timer = window.setTimeout(() => setFeedback(""), 2000);
    return () => window.clearTimeout(timer);
  }, [feedback, position]);

  useEffect(() => {
    if (!map) return;
    const show = (event: MapMouseEvent) => {
      event.originalEvent.preventDefault();
      setFeedback("");
      setPosition({ lng: event.lngLat.wrap().lng, lat: event.lngLat.lat });
    };
    map.on("contextmenu", show);
    return () => { map.off("contextmenu", show); };
  }, [map]);

  useEffect(() => {
    if (!map || !position) return;
    const popup = new Popup({ className: "map-coordinates", closeButton: false, closeOnMove: true, maxWidth: "none" })
      .setLngLat(position).setDOMContent(content).addTo(map);
    const close = () => setPosition(null);
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        popup.remove();
      }
    };
    popup.on("close", close);
    document.addEventListener("keydown", key);
    return () => {
      popup.off("close", close);
      popup.remove();
      document.removeEventListener("keydown", key);
    };
  }, [map, position, content]);

  if (!position) return null;
  const coordinates = `${position.lat.toFixed(5)}, ${position.lng.toFixed(5)}`;
  const copy = async () => {
    setFeedback("");
    try {
      await navigator.clipboard.writeText(coordinates);
      if (latestPosition.current === position) setFeedback("Copied");
    } catch {
      if (latestPosition.current === position)
        setFeedback("Could not copy. Select the coordinates to copy manually.");
    }
  };
  return createPortal(
    <div>
      <div className="coordinate-row">
        <span title="Latitude, longitude">{coordinates}</span>
        <button type="button" onClick={() => void copy()} aria-label={feedback === "Copied" ? "Coordinates copied" : "Copy coordinates"} title={feedback === "Copied" ? "Copied" : "Copy coordinates"}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
            {feedback === "Copied" ? <path d="m5 12 4 4L19 6" strokeLinecap="round" strokeLinejoin="round" /> : <>
              <rect x="8" y="8" width="12" height="12" rx="2" />
              <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
            </>}
          </svg>
        </button>
      </div>
      <p className={`coordinate-feedback${feedback === "Copied" ? " coordinate-copied" : ""}`} role="status">{feedback}</p>
    </div>,
    content,
  );
}
