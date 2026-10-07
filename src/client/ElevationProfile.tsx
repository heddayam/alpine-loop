import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { HikeRoute, Position } from "../model.js";
import { distanceText, elevationText, unitsFor, type UnitSystem } from "./units.js";

const WIDTH = 280;
const HEIGHT = 162;
const LEFT = 6;
const RIGHT = 274;
const TOP = 6;
const BOTTOM = 140;

type ProfileSample = { distance: number; position: Position };

/** Horizontal distance uses the same Earth diameter as prepared trail lengths. */
export function elevationSamples(geometry: Position[]): ProfileSample[] {
  let distance = 0;
  const radians = Math.PI / 180;
  return geometry.map((position, index) => {
    const previous = geometry[index - 1];
    if (previous) {
      const a = previous[1] * radians;
      const b = position[1] * radians;
      const h =
        Math.sin((b - a) / 2) ** 2 +
        Math.cos(a) *
          Math.cos(b) *
          Math.sin(((position[0] - previous[0]) * radians) / 2) ** 2;
      distance += 12742017.6 * Math.asin(Math.min(1, Math.sqrt(h)));
    }
    return { distance, position };
  });
}

function finitePosition(position: Position): Position {
  return Number.isFinite(position[2])
    ? [...position]
    : [position[0], position[1]];
}

function sampleIndex(samples: ProfileSample[], distance: number): number {
  let low = 0;
  let high = samples.length - 1;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (samples[middle]!.distance < distance) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Repeated trail segments remain separate positions along the ordered walk. */
export function elevationPosition(
  samples: ProfileSample[],
  distance: number,
): Position | null {
  if (!samples.length) return null;
  if (distance <= 0) return finitePosition(samples[0]!.position);
  if (distance >= samples.at(-1)!.distance)
    return finitePosition(samples.at(-1)!.position);
  const index = sampleIndex(samples, distance);
  const after = samples[index]!;
  if (after.distance === distance) return finitePosition(after.position);
  const before = samples[index - 1]!;
  const fraction =
    (distance - before.distance) / (after.distance - before.distance);
  const a = before.position;
  const b = after.position;
  const longitude = a[0] + (((b[0] - a[0] + 540) % 360) - 180) * fraction;
  const position: Position = [
    ((longitude + 540) % 360) - 180,
    a[1] + (b[1] - a[1]) * fraction,
  ];
  if (Number.isFinite(a[2]) && Number.isFinite(b[2])) {
    position.push(a[2]! + (b[2]! - a[2]!) * fraction);
  }
  return position;
}

/** Signed rise/run over a 100 m window, clipped at the walk's endpoints. */
export function elevationGrade(
  samples: ProfileSample[],
  distance: number,
): number | null {
  const total = samples.at(-1)?.distance ?? 0;
  if (!total || !Number.isFinite(distance)) return null;
  const center = Math.max(0, Math.min(total, distance));
  const start = Math.max(0, center - 50);
  const end = Math.min(total, center + 50);
  const a = elevationPosition(samples, start)?.[2];
  const b = elevationPosition(samples, end)?.[2];
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  for (
    let i = sampleIndex(samples, start);
    i < samples.length && samples[i]!.distance < end;
    i++
  ) {
    if (!Number.isFinite(samples[i]!.position[2])) return null;
  }
  return ((b! - a!) / (end - start)) * 100;
}

function tickStep(range: number) {
  const magnitude = 10 ** Math.floor(Math.log10(range));
  const fraction = range / magnitude;
  return (
    (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * magnitude
  );
}

/** Profile motion goes straight to its map marker; the application does not rerender. */
export function createProfileCursor() {
  const listeners = new Set<(position: Position | null) => void>();
  return {
    set: (position: Position | null) => {
      for (const listener of listeners) listener(position);
    },
    subscribe: (listener: (position: Position | null) => void) => {
      listeners.add(listener);
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
}: {
  route: HikeRoute;
  units?: UnitSystem;
  onHover: (position: Position | null) => void;
}) {
  const display = unitsFor(units);
  const samples = useMemo(
    () => elevationSamples(route.geometry),
    [route.geometry],
  );
  const [cursor, setCursor] = useState<number | null>(null);
  const hover = useRef(onHover);
  const frame = useRef(0);
  const pending = useRef<number | null>(null);
  hover.current = onHover;
  useEffect(() => {
    setCursor(null);
    hover.current(null);
    return () => {
      cancelAnimationFrame(frame.current);
      frame.current = 0;
      hover.current(null);
    };
  }, [route.id, samples]);

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
    const step = tickStep((maximum - minimum + 2 * padding) / 3);
    const floor = Math.floor((minimum - padding) / step) * step;
    const ceiling = Math.ceil((maximum + padding) / step) * step;
    const ticks = Array.from(
      { length: Math.round((ceiling - floor) / step) + 1 },
      (_, i) => floor + i * step,
    );
    const total = samples.at(-1)!.distance;
    const x = (distance: number) =>
      LEFT + ((RIGHT - LEFT) * distance) / (total || 1);
    const y = (elevation: number) =>
      BOTTOM - ((BOTTOM - TOP) * (elevation - floor)) / (ceiling - floor);
    let path = "";
    let connected = false;
    for (const sample of samples) {
      if (!Number.isFinite(sample.position[2])) {
        connected = false;
        continue;
      }
      path += `${connected ? "L" : "M"}${x(sample.distance).toFixed(2)},${y(sample.position[2]! / display.elevation).toFixed(2)}`;
      connected = true;
    }
    return { ticks, total, x, y, path };
  }, [samples, display]);
  if (!chart) {
    return (
      <section className="elevation-profile">
        <p>No elevation data</p>
      </section>
    );
  }
  const { ticks, total, x, y, path } = chart;
  const distance = (meters: number) => distanceText(meters, units, total < display.distance ? 2 : 1);
  const position = cursor === null ? null : elevationPosition(samples, cursor);
  const elevation = position?.[2];
  const grade = cursor === null ? null : elevationGrade(samples, cursor);
  const roundedGrade = grade === null ? null : Math.round(grade * 10) / 10;
  const readout =
    cursor === null
      ? ""
      : `${distance(cursor)} ${display.distanceLabel}${Number.isFinite(elevation) ? `, ${elevationText(elevation!, units)} ${display.elevationLabel}` : ""}${roundedGrade === null ? "" : `, ${roundedGrade > 0 ? "+" : ""}${roundedGrade.toFixed(1)}% grade`}`;
  const move = (distance: number | null) => {
    const next =
      distance === null ? null : Math.max(0, Math.min(total, distance));
    pending.current = next;
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const position = pending.current;
      setCursor(position);
      hover.current(
        position === null ? null : elevationPosition(samples, position),
      );
    });
  };

  return (
    <section className="elevation-profile" aria-label="Hike elevation profile">
      <header>
        <output className="profile-readout">{readout}</output>
      </header>
      <svg
        className="profile-chart"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        width={WIDTH}
        height={HEIGHT}
        role="slider"
        tabIndex={0}
        aria-label="Elevation profile position"
        aria-valuemin={0}
        aria-valuemax={total / display.distance}
        aria-valuenow={(cursor ?? 0) / display.distance}
        aria-valuetext={cursor === null ? `0 ${display.distanceLabel}` : readout}
        onPointerMove={(event) => {
          const bounds = event.currentTarget.getBoundingClientRect();
          const chartX = ((event.clientX - bounds.left) / bounds.width) * WIDTH;
          move(((chartX - LEFT) / (RIGHT - LEFT)) * total);
        }}
        onPointerLeave={() => move(null)}
        onFocus={() => {
          if (cursor === null) move(0);
        }}
        onBlur={() => move(null)}
        onKeyDown={(event) => {
          if (event.key === "Home") move(0);
          else if (event.key === "End") move(total);
          else if (event.key === "ArrowRight" || event.key === "ArrowUp")
            move((cursor ?? 0) + total / 100);
          else if (event.key === "ArrowLeft" || event.key === "ArrowDown")
            move((cursor ?? 0) - total / 100);
          else if (event.key === "Escape") move(null);
          else return;
          event.preventDefault();
        }}
      >
        {ticks.map((tick) => (
          <line
            key={tick}
            className="profile-grid"
            x1={LEFT}
            x2={RIGHT}
            y1={y(tick)}
            y2={y(tick)}
          />
        ))}
        <path className="profile-line" d={path} fill="none" />
        {ticks.map((tick) => (
          <text
            key={tick}
            className="profile-tick profile-elevation-tick"
            x={LEFT + 3}
            y={Math.max(TOP + 11, y(tick) - 4)}
            textAnchor="start"
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
              y={BOTTOM + 15}
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
            y1={TOP}
            y2={BOTTOM}
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
    </section>
  );
});
