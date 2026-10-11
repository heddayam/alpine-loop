import { useEffect, useLayoutEffect, useMemo, useRef, useState, type Ref } from "react";
import { routeName } from "../route-name.js";
import type { JobSnapshot, RouteView } from "../model.js";
import { ElevationProfile, type ProfileHover } from "./ElevationProfile.js";
import { StarIcon } from "./StarIcon.js";
import { savedResultsURL } from "./JobsDialog.js";
import { distanceText, elevationText, stemDistance, unitsFor, type UnitSystem } from "./units.js";

const startName = (route: RouteView) => {
  const name = route.startName?.trim();
  return !name || /^(Trail entrance|Mapped parking access|Trail start|Trailhead)$/i.test(name)
    ? "Unnamed trailhead"
    : name;
};

export function RouteCard({
  ref, route, job, units, error, starred, onToggleStar, onClose, onRetry, onProfileHover, onTrailHover,
}: {
  ref?: Ref<HTMLElement>;
  route: RouteView | null;
  job: JobSnapshot;
  units: UnitSystem;
  error: string;
  starred: boolean;
  onToggleStar: () => void;
  onClose: () => void;
  onRetry: () => void;
  onProfileHover: ProfileHover;
  onTrailHover: (name: string | null) => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const metrics = useRef<HTMLTableElement>(null);
  const footer = useRef<HTMLElement>(null);
  const trailList = useRef<HTMLUListElement>(null);
  const trailLabel = useRef<HTMLSpanElement>(null);
  const trailToggle = useRef<HTMLButtonElement>(null);
  const [readoutTarget, setReadoutTarget] = useState<HTMLDivElement | null>(null);
  const [plotHeight, setPlotHeight] = useState(104);
  const [allTrails, setAllTrails] = useState(false);
  const [visibleTrails, setVisibleTrails] = useState(0);
  const trails = useMemo(() => route ? [...new Set(route.trailNames)] : [], [route?.trailNames]);
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, []);
  useEffect(() => () => onTrailHover(null), [onTrailHover]);
  useEffect(() => {
    const table = metrics.current;
    if (!table) return;
    const measure = () => setPlotHeight(table.getBoundingClientRect().height);
    const observer = new ResizeObserver(measure);
    observer.observe(table);
    measure();
    return () => observer.disconnect();
  }, [route?.id]);
  useLayoutEffect(() => {
    const row = footer.current, list = trailList.current;
    const label = trailLabel.current, toggle = trailToggle.current;
    if (!row || !list || !label || !toggle) return;
    const measure = () => {
      const gap = parseFloat(getComputedStyle(row).columnGap);
      const listGap = parseFloat(getComputedStyle(list).columnGap);
      const labelWidth = label.getBoundingClientRect().width + parseFloat(getComputedStyle(label).marginRight);
      const available = row.clientWidth - labelWidth - gap;
      const widths = [...list.children].map(item => item.getBoundingClientRect().width);
      const total = widths.reduce((sum, width) => sum + width, 0) + Math.max(0, widths.length - 1) * listGap;
      if (total <= available) {
        setVisibleTrails(widths.length);
        return;
      }
      const room = available - toggle.getBoundingClientRect().width - gap;
      let used = 0, count = 0;
      for (const width of widths) {
        const next = used + width + (count ? listGap : 0);
        if (next > room) break;
        used = next;
        count++;
      }
      setVisibleTrails(count);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    measure();
    // Web-font metrics can change how many names fit without changing the row width.
    let active = true;
    void document.fonts.ready.then(() => { if (active) measure(); });
    return () => { active = false; observer.disconnect(); };
  }, [trails, allTrails]);
  const display = unitsFor(units);
  const name = route ? routeName(route) : "Hike details";
  const trailhead = route ? startName(route) : "";
  return (
    <aside
      ref={ref}
      className="map-route-card"
      aria-label="Selected hike"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <header className="route-card-header">
        <div className="route-card-identity">
          <h2 ref={heading} id="route-detail-heading" tabIndex={-1} title={name}>
            {name}
          </h2>
          {route && <p className="route-card-trailhead" title={trailhead} aria-label={`Trailhead: ${trailhead}`}>{trailhead}</p>}
        </div>
        <div className="route-card-profile-header">
          <div className="route-card-tools">
            {route && <>
              <button className="star-route" type="button" aria-label={starred ? "Unstar route" : "Star route"}
                aria-pressed={starred} onClick={onToggleStar}>
                <StarIcon filled={starred} />
              </button>
              <a className="gpx-download"
                href={savedResultsURL(job, `routes/${encodeURIComponent(route.id)}.gpx`, `units=${units}`)} download>
                Download GPX
              </a>
            </>}
            <button className="close-route-card" type="button" aria-label="Close hike details" onClick={onClose}>
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                <path d="M4 4 12 12M12 4 4 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </button>
          </div>
          <div ref={setReadoutTarget} className="route-card-readout" />
        </div>
      </header>
      {route ? (
        <div className="route-detail">
          <table ref={metrics} className="detail-metrics" aria-label="Route statistics"><tbody>
            <tr><th scope="row">Distance</th><td>{distanceText(route.distance, units)}</td><td className="metric-unit">{display.distanceLabel}</td></tr>
            <tr><th scope="row">Elevation gain</th><td>{elevationText(route.gain, units)}</td><td className="metric-unit">{display.elevationLabel}</td></tr>
            <tr><th scope="row" title="One-way approach walked again on the return">Approach <span className="metric-note">one way</span></th><td>{distanceText(stemDistance(route), units)}</td><td className="metric-unit">{display.distanceLabel}</td></tr>
            <tr><th scope="row">Roads</th><td>{distanceText(route.roadDistance, units, 2)}</td><td className="metric-unit">{display.distanceLabel}, <span className="road-fraction">{(route.distance > 0 ? 100 * route.roadDistance / route.distance : 0).toFixed(1)}%</span></td></tr>
          </tbody></table>
          <ElevationProfile key={route.id} route={route} units={units} onHover={onProfileHover}
            readoutTarget={readoutTarget} plotHeight={plotHeight} />
          {!!trails.length && <footer ref={footer} className="route-card-footer">
              <span ref={trailLabel} className="route-footer-label">Trails</span>
              <ul ref={trailList} className={`trail-names${allTrails ? " is-expanded" : ""}`} id="route-trail-names">
                {trails.map((trail, index) => <li key={trail} hidden={!allTrails && index >= visibleTrails}>
                  <button type="button" title={trail}
                    onPointerEnter={() => onTrailHover(trail)}
                    onPointerLeave={event => { if (document.activeElement !== event.currentTarget) onTrailHover(null); }}
                    onFocus={() => onTrailHover(trail)} onBlur={() => onTrailHover(null)}>{trail}</button>
                </li>)}
              </ul>
              <button ref={trailToggle} type="button" className="trail-list-toggle"
                hidden={!allTrails && visibleTrails === trails.length}
                aria-expanded={allTrails} aria-controls="route-trail-names"
                onClick={() => { onTrailHover(null); setAllTrails(value => !value); }}>
                {allTrails ? "Show fewer" : `Show all ${trails.length}`}
              </button>
          </footer>}
        </div>
      ) : (
        <div className="route-loading">
          <p role={error ? "alert" : "status"}>{error || "Loading hike details…"}</p>
          {error && <button type="button" onClick={() => {
            heading.current?.focus({ preventScroll: true });
            onRetry();
          }}>Retry</button>}
        </div>
      )}
    </aside>
  );
}
