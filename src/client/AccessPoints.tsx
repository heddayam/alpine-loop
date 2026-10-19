import { useEffect, useRef, useState } from "react";
import { Popup, type Map as MapLibreMap, type GeoJSONSource, type ExpressionSpecification } from "maplibre-gl";
import type { AccessPoint, AccessPointPolicy, Bounds } from "../model.js";
import { request } from "./request.js";

const empty = { type: "FeatureCollection" as const, features: [] };
const kinds = { trailhead: "Trailhead", parking: "Parking", "road-contact": "Road contact" };
const color: ExpressionSpecification = ["match", ["get", "kind"], "trailhead", "#24734b", "parking", "#245b9b", "#a85d17"];

export function AccessPoints({ map, enabled }: { map: MapLibreMap | null; enabled: boolean }) {
  const [shown, setShown] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [policy, setPolicy] = useState<AccessPointPolicy | null>(null);
  const [view, setView] = useState<'before' | 'after' | 'removed'>('after');
  const popup = useRef<Popup | null>(null);
  useEffect(() => {
    if (!map) return;
    map.addSource("access-points", { type: "geojson", data: empty });
    map.addLayer({ id: "access-points", type: "circle", source: "access-points", paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 5, 2, 11, 4, 16, 6],
      "circle-color": color, "circle-stroke-color": color, "circle-stroke-width": 1.5,
      "circle-opacity": ["case", ["==", ["get", "access"], "unknown"], 0.15, 1],
    } });
    return () => {
      if (map.getLayer("access-points")) map.removeLayer("access-points");
      if (map.getSource("access-points")) map.removeSource("access-points");
    };
  }, [map]);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void request<AccessPointPolicy | null>('/api/access-point-policy', controller.signal)
      .then(value => { if (!controller.signal.aborted) setPolicy(value); }).catch(() => {});
    return () => controller.abort();
  }, [enabled, retry]);

  useEffect(() => {
    if (!map) return;
    popup.current?.remove();
    map.setFilter('access-points', !policy || view === 'before' ? null : view === 'removed'
      ? ['==', ['get', 'trialKeep'], false]
      : ['any', ['!', ['has', 'trialKeep']], ['==', ['get', 'trialKeep'], true]]);
  }, [map, policy, view]);

  useEffect(() => {
    if (!map) return;
    const source = map.getSource("access-points") as GeoJSONSource;
    let controller: AbortController | undefined;
    let loaded: Bounds | undefined;
    source.setData(empty);
    setError(""); setLoading(false);
    if (!enabled || !shown) return;
    const load = () => {
      const bounds = map.getBounds();
      const view: Bounds = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];
      if (loaded && view[0] >= loaded[0] && view[1] >= loaded[1] && view[2] <= loaded[2] && view[3] <= loaded[3]) return;
      controller?.abort(); popup.current?.remove();
      const pending = new AbortController(); controller = pending;
      const x = (view[2] - view[0]) / 4, y = (view[3] - view[1]) / 4;
      const window: Bounds = [Math.max(-180, view[0] - x), Math.max(-90, view[1] - y), Math.min(180, view[2] + x), Math.min(90, view[3] + y)];
      const query = new URLSearchParams(["west", "south", "east", "north"].map((key, i) => [key, String(window[i])]));
      setLoading(true); setError("");
      void request<AccessPoint[]>(`/api/access-points?${query}`, pending.signal).then(points => {
        if (pending.signal.aborted) return;
        loaded = window;
        source.setData({ type: "FeatureCollection", features: points.map(({ position, assessment, ...properties }) => ({
          type: "Feature", properties: { ...properties, ...(assessment ? { trialKeep: assessment.keep, trialReason: assessment.reason } : {}) },
          geometry: { type: "Point", coordinates: [position[0], position[1]] },
        })) });
      }).catch(() => { if (!pending.signal.aborted) setError("Access points could not load."); })
        .finally(() => { if (!pending.signal.aborted) setLoading(false); });
    };
    const inspect = (event: import("maplibre-gl").MapLayerMouseEvent) => {
      const feature = event.features?.[0];
      if (!feature || feature.geometry.type !== "Point") return;
      const point = feature.properties as AccessPoint & { trialKeep?: boolean; trialReason?: string };
      const content = document.createElement("div"); content.className = "access-point-details";
      const title = document.createElement("strong"); title.textContent = point.name; content.append(title);
      for (const text of [kinds[point.kind], point.access === "unknown" ? "Access uncertain" : "Public access", point.region,
        ...(point.kind === "road-contact" ? ["Mapped road contact, parking not verified."] : []),
        ...(point.trialReason ? [`${point.trialKeep ? 'Eligible for search' : 'Excluded from search'}. ${point.trialReason}`] : [])]) {
        const line = document.createElement("p"); line.textContent = text; content.append(line);
      }
      const [lon, lat] = feature.geometry.coordinates;
      const link = document.createElement("a"); link.textContent = "View in OpenStreetMap";
      const osmNode = /\/osm-entrance:(\d+)$/.exec(point.id)?.[1];
      link.href = osmNode ? `https://www.openstreetmap.org/node/${osmNode}` : `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=17/${lat}/${lon}`;
      link.target = "_blank"; link.rel = "noopener noreferrer"; content.append(link);
      popup.current?.remove();
      popup.current = new Popup({ maxWidth: "280px" }).setLngLat([lon!, lat!]).setDOMContent(content).addTo(map);
    };
    load(); map.on("moveend", load); map.on("resize", load); map.on("click", "access-points", inspect);
    return () => {
      controller?.abort(); popup.current?.remove(); source.setData(empty);
      map.off("moveend", load); map.off("resize", load); map.off("click", "access-points", inspect);
    };
  }, [map, enabled, shown, retry]);

  if (!enabled) return null;
  return <div className="access-points-control search-area-control">
    <label><input type="checkbox" checked={shown} onChange={event => setShown(event.target.checked)} />Show access points</label>
    {shown && <>
      <div className="access-points-legend">{Object.entries(kinds).map(([kind, label]) =>
        <span key={kind}><i className={`access-point-key ${kind}`} />{label}</span>)}</div>
      <small>All installed regions. Outlined points have uncertain access.</small>
      {policy && <div className="access-point-trial">
        <div className="access-point-trial-views" role="group" aria-label="Access-point eligibility comparison">
          {(['before', 'after', 'removed'] as const).map(mode => <button type="button" key={mode} aria-pressed={view === mode}
            onClick={() => setView(mode)}>{mode === 'before' ? 'Before' : mode === 'after' ? 'After' : 'Removed'}</button>)}
        </div>
        <small>{policy.before.toLocaleString()} before, {policy.after.toLocaleString()} after. Searches use After.</small>
        <details><summary>Access-point rules</summary>{policy.rules.map(rule => <p key={rule}>{rule}</p>)}<p>Before and Removed are comparison views. Search-area and access settings further filter the After points.</p></details>
      </div>}
      {loading && <small role="status">Loading access points…</small>}
      {error && <small role="alert">{error} <button type="button" onClick={() => setRetry(value => value + 1)}>Retry</button></small>}
    </>}
  </div>;
}
