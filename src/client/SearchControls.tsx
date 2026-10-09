import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { CatalogView } from "../data-format.js";
import { DEFAULT_ROAD_LIMITS, type GradeLimits, type SearchBoundary, type SearchQuery } from "../model.js";
import { GradeLimitsControl, type GradeDraft } from "./GradeLimits.js";
import { SteppedNumber } from "./SteppedNumber.js";
import { RegionPicker } from "./RegionPicker.js";
import { stemLimit, unitsFor, type UnitSystem } from "./units.js";

const MILE = 1609.344;
const FOOT = 0.3048;
type Measurement =
  | "distanceMin"
  | "distanceMax"
  | "gainMin"
  | "gainMax"
  | "stem"
  | "roadDistance"
  | "uphillTotal" | "uphillLongest" | "downhillTotal" | "downhillLongest";
const measurementKeys: Measurement[] = [
  "distanceMin", "distanceMax", "gainMin", "gainMax", "stem", "roadDistance",
  "uphillTotal", "uphillLongest", "downhillTotal", "downhillLongest",
];
const displayValue = (meters: number, divisor: number, gain: boolean) =>
  String(Number((meters / divisor).toFixed(gain ? 1 : 3)));

export type SearchDraft = {
  sections: string[];
  boundary?: SearchBoundary;
  distance: [string, string];
  gain: [string, string];
  stem: string;
  stemPercent: string;
  roadDistance: string;
  grades?: GradeDraft;
  /** Preserve exact limits when unit conversion rounds their displayed text. */
  exact?: {
    units: UnitSystem;
    values: Partial<Record<Measurement, { text: string; meters: number }>>;
  };
};

const fields = (draft: SearchDraft): Record<Measurement, string> => ({
  distanceMin: draft.distance[0],
  distanceMax: draft.distance[1],
  gainMin: draft.gain[0],
  gainMax: draft.gain[1],
  stem: draft.stem,
  roadDistance: draft.roadDistance,
  uphillTotal: draft.grades?.uphill.total ?? "",
  uphillLongest: draft.grades?.uphill.longest ?? "",
  downhillTotal: draft.grades?.downhill.total ?? "",
  downhillLongest: draft.grades?.downhill.longest ?? "",
});
const measurement = (draft: SearchDraft, key: Measurement, units: UnitSystem) => {
  const text = fields(draft)[key];
  const original = draft.exact?.values[key];
  return draft.exact?.units === units && original?.text === text
    ? original.meters
    : Number(text) * unitsFor(units)[key.startsWith("gain") ? "elevation" : "distance"];
};
function withMeasurements(
  draft: SearchDraft,
  values: Partial<Record<Measurement, number>>,
  units: UnitSystem,
): SearchDraft {
  const text = fields(draft);
  const exact: NonNullable<SearchDraft["exact"]> = { units, values: {} };
  for (const key of measurementKeys) {
    const meters = values[key];
    if (meters === undefined || !Number.isFinite(meters)) continue;
    text[key] = displayValue(
      meters,
      unitsFor(units)[key.startsWith("gain") ? "elevation" : "distance"],
      key.startsWith("gain"),
    );
    exact.values[key] = { text: text[key], meters };
  }
  return {
    ...draft,
    distance: [text.distanceMin, text.distanceMax],
    gain: [text.gainMin, text.gainMax],
    stem: text.stem,
    roadDistance: text.roadDistance,
    ...(draft.grades ? { grades: {
      ...draft.grades,
      uphill: { ...draft.grades.uphill, total: text.uphillTotal, longest: text.uphillLongest },
      downhill: { ...draft.grades.downhill, total: text.downhillTotal, longest: text.downhillLongest },
    } } : {}),
    exact,
  };
}

export function draftForQuery(query: SearchQuery, units: UnitSystem = "imperial"): SearchDraft {
  const roads = query.roads ?? DEFAULT_ROAD_LIMITS;
  const savedGrades = query.grades;
  const grades = savedGrades ?? {
    uphill: { above: 15, total: 0.5 * MILE, longest: 0.2 * MILE },
    downhill: { above: 15, total: 0.25 * MILE, longest: 0.1 * MILE },
  };
  return withMeasurements({
    sections: [...query.sections],
    ...(query.boundary ? { boundary: query.boundary.map(point => [...point]) } : {}),
    distance: ["", ""],
    gain: ["", ""],
    stem: "",
    stemPercent: String((query.repetition ?? 1) * 100),
    roadDistance: "",
    grades: {
      enabled: !!savedGrades,
      uphill: { above: String(grades.uphill.above), total: "", longest: "" },
      downhill: { above: String(grades.downhill.above), total: "", longest: "" },
    },
  }, {
    distanceMin: query.distance[0],
    distanceMax: query.distance[1],
    gainMin: query.gain[0],
    gainMax: query.gain[1],
    stem: stemLimit(query),
    roadDistance: roads.distance,
    uphillTotal: grades.uphill.total,
    uphillLongest: grades.uphill.longest,
    downhillTotal: grades.downhill.total,
    downhillLongest: grades.downhill.longest,
  }, units);
}

export const initialDraft = draftForQuery({
  sections: [],
  distance: [5 * MILE, 12 * MILE],
  gain: [0, 4000 * FOOT],
  stem: 2 * MILE,
  repetition: 0.2,
  roads: { distance: 0.5 * MILE, fraction: 1 },
  includeUnknown: true,
});

export function convertDraft(draft: SearchDraft, from: UnitSystem, to: UnitSystem): SearchDraft {
  const values: Partial<Record<Measurement, number>> = {};
  for (const key of measurementKeys) {
    if (fields(draft)[key].trim()) values[key] = measurement(draft, key, from);
  }
  return withMeasurements(draft, values, to);
}

/** Validate every exposed limit before making a request; blank is never zero. */
export function queryForDraft(draft: SearchDraft, units: UnitSystem = "imperial"): SearchQuery {
  const values = [
    ...draft.distance,
    ...draft.gain,
    draft.stem,
    draft.stemPercent,
    draft.roadDistance,
  ];
  const minDistance = measurement(draft, "distanceMin", units);
  const maxDistance = measurement(draft, "distanceMax", units);
  const minGain = measurement(draft, "gainMin", units);
  const maxGain = measurement(draft, "gainMax", units);
  if (!draft.sections.length)
    throw new Error("Select at least one search region.");
  if (
    values.some(
      (value) =>
        !value.trim() || !Number.isFinite(Number(value)) || Number(value) < 0,
    ) ||
    Number(draft.stemPercent) > 100 ||
    maxDistance <= 0 ||
    minDistance > maxDistance ||
    minGain > maxGain
  ) {
    throw new Error(
      "Use a positive maximum distance and ordered, nonnegative distance and elevation gain ranges. In More options, approach and road distance must be zero or greater; approach percentage must be between 0 and 100.",
    );
  }
  let grades: GradeLimits | undefined;
  if (draft.grades?.enabled) {
    const entries = [draft.grades.uphill, draft.grades.downhill];
    if (entries.some(entry => Object.values(entry).some(value =>
      !value.trim() || !Number.isFinite(Number(value)) || Number(value) < 0,
    ))) throw new Error("Grade thresholds and allowed distances must be zero or greater.");
    grades = {
      uphill: { above: Number(draft.grades.uphill.above), total: measurement(draft, "uphillTotal", units), longest: measurement(draft, "uphillLongest", units) },
      downhill: { above: Number(draft.grades.downhill.above), total: measurement(draft, "downhillTotal", units), longest: measurement(draft, "downhillLongest", units) },
    };
  }
  return {
    ...(grades ? { grades } : {}),
    sections: [...draft.sections],
    ...(draft.boundary ? { boundary: draft.boundary.map(point => [...point]) } : {}),
    distance: [minDistance, maxDistance],
    gain: [minGain, maxGain],
    stem: measurement(draft, "stem", units),
    repetition: Number(draft.stemPercent) / 100,
    roads: { distance: measurement(draft, "roadDistance", units), fraction: 1 },
    includeUnknown: true,
    effort: "deep",
  };
}


function Range({
  name,
  unit,
  value,
  onChange,
  step,
}: {
  name: string;
  unit: string;
  value: [string, string];
  onChange: (next: [string, string]) => void;
  step: number;
}) {
  const key = name.toLowerCase().replaceAll(" ", "-");
  return (
    <fieldset className="numeric-field" data-unit={unit}>
      <legend>
        {name} <span className="field-unit">{unit}</span>
      </legend>
      <div className="range-pair">
        <SteppedNumber
          id={`${key}-min`}
          label={`Minimum ${name.toLowerCase()} (${unit})`}
          bound="Min"
          value={value[0]}
          step={step}
          onChange={(next) => onChange([next, value[1]])}
        />
        <SteppedNumber
          id={`${key}-max`}
          label={`Maximum ${name.toLowerCase()} (${unit})`}
          bound="Max"
          value={value[1]}
          step={step}
          onChange={(next) => onChange([value[0], next])}
        />
      </div>
    </fieldset>
  );
}

function Maximum({
  id,
  name,
  unit,
  title,
  value,
  step,
  max,
  onChange,
}: {
  id: string;
  name: string;
  unit: string;
  title?: string;
  value: string;
  step: number;
  max?: number;
  onChange: (value: string) => void;
}) {
  return (
    <div className="numeric-field" data-unit={unit}>
      <label className="field-label" htmlFor={id} title={title}>
        {name} <span className="field-unit">{unit}</span>
      </label>
      <SteppedNumber
        id={id}
        label={`Maximum ${name.toLowerCase()} (${unit})`}
        bound="Max"
        value={value}
        step={step}
        max={max}
        onChange={onChange}
      />
    </div>
  );
}

export function SearchControls({
  dataset,
  savedSections,
  draft,
  disabled,
  submitting,
  units = "imperial",
  onChange,
  onSubmit,
  onDrawBoundary,
}: {
  dataset: CatalogView;
  savedSections?: { id: string; name: string }[];
  draft: SearchDraft;
  disabled: boolean;
  submitting: boolean;
  units?: UnitSystem;
  onChange: (draft: SearchDraft) => void;
  onSubmit: (event: FormEvent) => void;
  onDrawBoundary: () => void;
}) {
  const drawButton = useRef<HTMLButtonElement>(null);
  const options = useRef<HTMLDivElement>(null);
  const optionsButton = useRef<HTMLButtonElement>(null);
  const optionsId = useId();
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [optionsOffset, setOptionsOffset] = useState(0);
  useEffect(() => {
    if (!optionsOpen) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !options.current?.contains(event.target)) setOptionsOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOptionsOpen(false);
      optionsButton.current?.focus();
    };
    const resize = () => setOptionsOpen(false);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    window.addEventListener("resize", resize);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("resize", resize);
    };
  }, [optionsOpen]);
  useEffect(() => { if (disabled) setOptionsOpen(false); }, [disabled]);
  const update = (change: Partial<SearchDraft>) =>
    onChange({ ...draft, ...change });
  const display = unitsFor(units);
  const currentRegions =
    draft.sections.length > 0 &&
    draft.sections.every((id) =>
      dataset.sections.some((section) => section.id === id),
    );
  return (
    <form
      className="planner"
      aria-label="Search constraints"
      onSubmit={onSubmit}
    >
      <fieldset className="planner-fields" disabled={disabled}>
        <div className="region-field">
          <span className="field-label">Search area</span>
          <div className="search-area-controls">
            <RegionPicker
              dataset={dataset}
              savedSections={savedSections}
              value={draft.sections}
              boundary={draft.boundary}
              disabled={disabled}
              onChange={(sections) => update({ sections, boundary: undefined })}
            />
            {!draft.boundary && <span className="area-choice-separator">or</span>}
            <button
              ref={drawButton}
              type="button"
              className="area-action"
              disabled={disabled}
              onClick={onDrawBoundary}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
                <path d="M7 1.5 12.3 5.3 10.3 12H3.7L1.7 5.3Z" strokeLinejoin="round" />
              </svg>
              {draft.boundary ? "Redraw" : "Draw"}
            </button>
            {draft.boundary && <button
              type="button"
              className="area-action clear-area"
              disabled={disabled}
              aria-label="Clear drawn area"
              title="Clear drawing and use the full selected regions"
              onClick={() => {
                update({ boundary: undefined, sections: [...draft.sections] });
                drawButton.current?.focus();
              }}
            >
              <span aria-hidden="true">×</span>
            </button>}
          </div>
        </div>
        <Range
          name="Distance"
          unit={display.distanceLabel}
          step={1}
          value={draft.distance}
          onChange={(distance) => update({ distance })}
        />
        <Range
          name="Elevation gain"
          step={display.gainStep}
          unit={display.elevationLabel}
          value={draft.gain}
          onChange={(gain) => update({ gain })}
        />
        <div className="search-options" ref={options} onBlur={event => {
          if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) setOptionsOpen(false);
        }}>
          <button ref={optionsButton} type="button" className="options-trigger"
            aria-expanded={optionsOpen} aria-controls={optionsId} onClick={() => {
              const left = options.current!.getBoundingClientRect().left;
              setOptionsOffset(Math.max(9 - left, Math.min(0, window.innerWidth - 357 - left)));
              setOptionsOpen(!optionsOpen);
            }}>
            More options <span aria-hidden="true">▾</span>
          </button>
          {optionsOpen && <div className="options-popover" id={optionsId} style={{ left: optionsOffset }}
            role="group" aria-label="Approach and road limits">
            <h3>Approach to the loop</h3>
            <p>The approach is walked out and back. Both limits below apply to its one-way distance.</p>
            <div className="options-fields">
              <Maximum id="stem" name="Approach distance" unit={display.distanceLabel}
                step={0.5} value={draft.stem} onChange={(stem) => update({ stem })} />
              <Maximum id="stem-percent" name="Share of total hike" unit="%"
                step={5} max={100} value={draft.stemPercent} onChange={(stemPercent) => update({ stemPercent })} />
            </div>
            <h3>Road walking</h3>
            <p>Total distance walked on roads, including any repeated sections.</p>
            <Maximum id="road-distance" name="Road distance" unit={display.distanceLabel}
              step={0.1} value={draft.roadDistance} onChange={(roadDistance) => update({ roadDistance })} />
            <p className="options-note">These limits apply even when More options is closed.</p>
          </div>}
        </div>
        <GradeLimitsControl
          value={draft.grades ?? convertDraft(initialDraft, "imperial", units).grades!}
          units={units}
          disabled={disabled}
          onChange={(grades) => update({ grades })}
        />
        <button
          className="primary search-button"
          type="submit"
          disabled={disabled || !currentRegions}
        >
          {submitting ? "Submitting…" : "Search"}
        </button>
      </fieldset>
    </form>
  );
}
