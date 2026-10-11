import { memo, useEffect, useId, useMemo, useRef, useState, type MouseEvent, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import type { HikeRoute, Position } from "../model.js";
import { distanceText, elevationText, unitsFor, type UnitSystem } from "./units.js";

import { elevationSamples, elevationPosition, elevationGrade, elevationSelection } from "../grade.js";
export { elevationSamples, elevationPosition, elevationGrade } from "../grade.js";

const LEFT = 58;

function tickStep(range: number) {
  const magnitude = 10 ** Math.floor(Math.log10(range));
  const fraction = range / magnitude;
  return (
    (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * magnitude
  );
}

export type ProfileHover = (position: Position | null, selection?: Position[] | null) => void;
type Inspection = { cursor: number | null; range: [number, number] | null; anchor: number | null; reversed: boolean };

/** Profile motion goes straight to the map; the application does not rerender. */
export function createProfileCursor() {
  const listeners = new Set<ProfileHover>();
  let current: [Position | null, Position[] | null] = [null, null];
  return {
    set: (position: Position | null, selection: Position[] | null = null) => {
      current = [position, selection];
      for (const listener of listeners) listener(position, selection);
    },
    subscribe: (listener: ProfileHover) => {
      listeners.add(listener);
      listener(...current);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
export type ProfileCursor = ReturnType<typeof createProfileCursor>;

export const ElevationProfile = memo(function ElevationProfile({
  route,
  units = "imperial",
  onHover,
  readoutTarget,
  plotHeight = 104,
}: {
  route: HikeRoute;
  units?: UnitSystem;
  onHover: ProfileHover;
  readoutTarget?: HTMLElement | null;
  plotHeight?: number;
}) {
  const display = unitsFor(units);
  const selectionClip = useId();
  const forwardSamples = useMemo(
    () => elevationSamples(route.geometry),
    [route.geometry],
  );
  const [inspection, setInspection] = useState<Inspection>({ cursor: null, range: null, anchor: null, reversed: false });
  const { cursor, range, anchor, reversed } = inspection;
  const samples = useMemo(() => {
    if (!reversed) return forwardSamples;
    const total = forwardSamples.at(-1)?.distance ?? 0;
    return forwardSamples.map(sample => ({ ...sample, distance: total - sample.distance })).reverse();
  }, [forwardSamples, reversed]);
  const selection = useMemo(() => range ? elevationSelection(samples, ...range) : null, [samples, range]);
  const container = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(360);
  const right = width - 4;
  const height = plotHeight + 14;
  const hover = useRef(onHover);
  const frame = useRef(0);
  const pending = useRef<Inspection>(inspection);
  hover.current = onHover;
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const measure = () => setWidth(Math.max(100, element.getBoundingClientRect().width));
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    pending.current = { cursor: null, range: null, anchor: null, reversed: false };
    setInspection(pending.current);
    hover.current(null);
    return () => {
      cancelAnimationFrame(frame.current);
      frame.current = 0;
      hover.current(null);
    };
  }, [route.id, forwardSamples]);
  useEffect(() => {
    hover.current(cursor === null ? null : elevationPosition(samples, cursor), selection?.geometry ?? null);
  }, [cursor, samples, selection]);

  const chart = useMemo(() => {
    let minimum = Infinity;
    let maximum = -Infinity;
    for (const { position } of samples) {
      if (!Number.isFinite(position[2])) continue;
      minimum = Math.min(minimum, position[2]! / display.elevation);
      maximum = Math.max(maximum, position[2]! / display.elevation);
    }
    if (minimum === Infinity) return null;
    const padding = Math.max((maximum - minimum) * 0.06, 6 / display.elevation);
    // Rounded tick labels fit inside the bounds without expanding the plot range.
    const floor = minimum - padding;
    const ceiling = maximum + padding;
    const step = tickStep((ceiling - floor) / 3);
    const firstTick = Math.ceil(floor / step) * step;
    const ticks = Array.from(
      { length: Math.floor((ceiling - firstTick) / step) + 1 },
      (_, i) => firstTick + i * step,
    );
    const total = samples.at(-1)!.distance;
    const x = (distance: number) =>
      LEFT + ((right - LEFT) * distance) / (total || 1);
    const y = (elevation: number) =>
      plotHeight - (plotHeight * (elevation - floor)) / (ceiling - floor);
    let path = "";
    let area = "";
    let lastX = "";
    let connected = false;
    for (const sample of samples) {
      if (!Number.isFinite(sample.position[2])) {
        if (connected) area += `L${lastX},${plotHeight}Z`;
        connected = false;
        continue;
      }
      lastX = x(sample.distance).toFixed(2);
      const point = `${lastX},${y(sample.position[2]! / display.elevation).toFixed(2)}`;
      path += `${connected ? "L" : "M"}${point}`;
      area += `${connected ? "" : `M${lastX},${plotHeight}`}L${point}`;
      connected = true;
    }
    if (connected) area += `L${lastX},${plotHeight}Z`;
    return { ticks, total, x, y, path, area };
  }, [samples, display, right, plotHeight]);
  if (!chart) {
    return (
      <section ref={container} className="elevation-profile">
        <p>No elevation data</p>
      </section>
    );
  }
  const { ticks, total, x, y, path, area } = chart;
  const distance = (meters: number) => distanceText(meters, units, total < display.distance ? 2 : 1);
  const position = cursor === null ? null : elevationPosition(samples, cursor);
  const elevation = position?.[2];
  const rawGrade = selection ? selection.grade : cursor === null ? null : elevationGrade(samples, cursor);
  const grade = rawGrade === null ? null : Math.round(rawGrade);
  const readout = selection
    ? `${distanceText(selection.distance, units, 2)} ${display.distanceLabel}, ${selection.gain === null ? "elevation unavailable" : `↑${elevationText(selection.gain, units)} ↓${elevationText(selection.loss!, units)} ${display.elevationLabel}, ${grade! > 0 ? "+" : ""}${grade}% avg`}`
    : anchor !== null ? "Click to finish"
    : cursor === null ? "Click to measure"
    : `${distance(cursor)} ${display.distanceLabel}${Number.isFinite(elevation) ? `, ${elevationText(elevation!, units)} ${display.elevationLabel}` : ""}${grade === null ? "" : `, ${grade > 0 ? "+" : ""}${grade}% grade`}`;
  const move = (distance: number | null, range = pending.current.range, anchor = pending.current.anchor) => {
    pending.current = { ...pending.current, cursor: distance === null ? null : Math.max(0, Math.min(total, distance)), range, anchor };
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      setInspection(pending.current);
    });
  };
  const pointerDistance = (event: PointerEvent<SVGSVGElement> | MouseEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const chartX = ((event.clientX - bounds.left) / bounds.width) * width;
    return Math.max(0, Math.min(total, ((chartX - LEFT) / (right - LEFT)) * total));
  };
  const select = (distance: number) => {
    const start = pending.current.anchor;
    if (start === null) move(distance, null, distance);
    else move(distance, [start, distance], null);
  };
  const output = <output className="profile-readout" style={{ paddingLeft: LEFT + 4 }}>
    <span title={selection ? "Average grade uses net elevation change over the selected distance." : "Click to set the start and end. Arrow keys move; Enter marks endpoints; Escape clears."}>{readout}</span>
    {(selection || anchor !== null) && <button type="button" className="profile-clear" aria-label="Clear profile selection"
      onClick={() => {
        move(null, null, null);
        container.current?.querySelector("svg")?.focus({ preventScroll: true });
      }}>Clear</button>}
  </output>;

  return (
    <section ref={container} className="elevation-profile" aria-label="Hike elevation profile">
      {readoutTarget
        ? createPortal(output, readoutTarget)
        : output}
      <div className="profile-plot">
        <svg
          className="profile-chart"
          viewBox={`0 0 ${width} ${height}`}
          width={width}
          height={height}
          style={{ height }}
          role="slider"
          tabIndex={0}
          aria-label={reversed ? "Elevation profile position, reversed" : "Elevation profile position"}
          aria-valuemin={0}
          aria-valuemax={total / display.distance}
          aria-valuenow={(cursor ?? 0) / display.distance}
          aria-valuetext={selection || cursor !== null ? readout : `0 ${display.distanceLabel}`}
          aria-description="Click to set the start and end of a stretch. Arrow keys move; Enter marks endpoints; Escape clears."
          onClick={(event) => {
            if (event.button !== 0) return;
            event.currentTarget.focus({ preventScroll: true });
            select(pointerDistance(event));
          }}
          onPointerMove={(event) => {
            if (!event.isPrimary || event.buttons) return;
            const next = pointerDistance(event);
            move(next, pending.current.anchor === null ? pending.current.range : [pending.current.anchor, next]);
          }}
          onPointerLeave={() => move(null)}
          onFocus={() => {
            if (cursor === null) move(0);
          }}
          onBlur={() => move(null)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && (pending.current.range || pending.current.anchor !== null)) {
              move(cursor, null, null);
              event.preventDefault();
              return;
            }
            if (event.key === "Enter" || event.key === " ") {
              select(pending.current.cursor ?? 0);
              event.preventDefault();
              return;
            }
            let next: number;
            if (event.key === "Home") next = 0;
            else if (event.key === "End") next = total;
            else if (event.key === "ArrowRight" || event.key === "ArrowUp")
              next = (pending.current.cursor ?? 0) + total / 100;
            else if (event.key === "ArrowLeft" || event.key === "ArrowDown")
              next = (pending.current.cursor ?? 0) - total / 100;
            else return;
            move(next, pending.current.anchor === null ? pending.current.range : [pending.current.anchor, next]);
            event.preventDefault();
          }}
        >
          <path className="profile-axis" d={`M${LEFT},0V${plotHeight}H${right}`} fill="none" />
          {ticks.map((tick) => (
            <line
              key={tick}
              className="profile-axis"
              x1={LEFT - 3}
              x2={LEFT}
              y1={y(tick)}
              y2={y(tick)}
            />
          ))}
          <path className="profile-line" d={path} fill="none" />
          {selection && <>
            <defs><clipPath id={selectionClip}>
              <rect x={x(selection.start)} y={0}
                width={x(selection.end) - x(selection.start)} height={plotHeight} />
            </clipPath></defs>
            <path className="profile-selection" d={area} clipPath={`url(#${selectionClip})`} />
            {[selection.start, selection.end].map(boundary => <line key={boundary}
              className="profile-cursor" x1={x(boundary)} x2={x(boundary)} y1={0} y2={plotHeight} />)}
          </>}
          {!selection && anchor !== null && <line className="profile-cursor"
            x1={x(anchor)} x2={x(anchor)} y1={0} y2={plotHeight} />}
          {ticks.map((tick) => (
            <text
              key={tick}
              className="profile-tick profile-elevation-tick"
              x={LEFT - 6}
              y={Math.max(10, Math.min(plotHeight - 2, y(tick) + 3))}
              textAnchor="end"
            >
              {`${Math.round(tick).toLocaleString()}${tick === ticks.at(-1) ? ` ${display.elevationLabel}` : ""}`}
            </text>
          ))}
          {[0, total / 2, total]
            .filter((distance, i, values) => values.indexOf(distance) === i)
            .map((tickDistance, i) => (
              <text
                className="profile-tick"
                key={tickDistance}
                x={x(tickDistance)}
                y={plotHeight + 11}
                textAnchor={
                  i === 0 ? "start" : tickDistance === total ? "end" : "middle"
                }
              >
                {`${distance(tickDistance)}${tickDistance === total ? ` ${display.distanceLabel}` : ""}`}
              </text>
            ))}
          {cursor !== null && (
            <line
              className="profile-cursor"
              x1={x(cursor)}
              x2={x(cursor)}
              y1={0}
              y2={plotHeight}
            />
          )}
          {cursor !== null && Number.isFinite(elevation) && (
            <circle
              className="profile-point"
              cx={x(cursor)}
              cy={y(elevation! / display.elevation)}
              r={3}
            />
          )}
        </svg>
        <button type="button" className="profile-reverse" title="Reverse profile"
          aria-label="Reverse profile" aria-pressed={reversed}
          onClick={() => {
            cancelAnimationFrame(frame.current);
            frame.current = 0;
            const current = pending.current;
            pending.current = {
              cursor: current.cursor === null ? null : total - current.cursor,
              range: current.range ? [total - current.range[0], total - current.range[1]] : null,
              anchor: current.anchor === null ? null : total - current.anchor,
              reversed: !current.reversed,
            };
            setInspection(pending.current);
          }}>
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <path d="M2 5h12l-3-3M14 11H2l3 3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
    </section>
  );
});
