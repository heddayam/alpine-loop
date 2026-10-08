import { useEffect, useId, useRef, useState } from "react";
import { unitsFor, type UnitSystem } from "./units.js";
export type GradeDraft = {
  enabled: boolean;
  uphill: { above: string; total: string; longest: string };
  downhill: { above: string; total: string; longest: string };
};

export function GradeLimitsControl({ value, units, disabled, onChange }: {
  value: GradeDraft;
  units: UnitSystem;
  disabled: boolean;
  onChange: (value: GradeDraft) => void;
}) {
  const [open, setOpen] = useState(false);
  const [offset, setOffset] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();
  const unit = unitsFor(units).distanceLabel;
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    const resize = () => setOpen(false);
    window.addEventListener("resize", resize);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("resize", resize);
    };
  }, [open]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  return (
    <div className="grade-limits" ref={root} onBlur={event => {
      if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
    }}>
      <div className={`grade-trigger${value.enabled ? " enabled" : ""}`}>
        <input type="checkbox" aria-label="Enable grade limits" checked={value.enabled}
          disabled={disabled} onChange={event => onChange({ ...value, enabled: event.target.checked })} />
        <button ref={button} type="button" disabled={disabled} aria-expanded={open}
          aria-controls={`${id}-panel`} onClick={() => {
            const left = root.current!.getBoundingClientRect().left;
            setOffset(Math.max(9 - left, Math.min(0, window.innerWidth - 388 - left)));
            setOpen(!open);
          }}>
          Grade limits <span aria-hidden="true">▾</span>
        </button>
      </div>
      {open && <div className="grade-popover" style={{ left: offset }} id={`${id}-panel`} role="group" aria-label="Grade limits settings">
        <div className="grade-grid">
          <span />
          <span className="grade-column">Above <span className="field-unit">%</span></span>
          <span className="grade-column">Total allowed <span className="field-unit">{unit}</span></span>
          <span className="grade-column">Longest stretch <span className="field-unit">{unit}</span></span>
          {(["uphill", "downhill"] as const).map(direction => {
            const label = direction === "uphill" ? "Uphill" : "Downhill";
            return <div className="grade-row" key={direction}>
              <span className="grade-direction">{label}</span>
              {(["above", "total", "longest"] as const).map(key => <input
                key={key} type="number" min="0" step="any"
                aria-label={`${label} ${key === "above" ? "grade threshold (%)" : `${key === "total" ? "total allowed" : "longest stretch"} (${unit})`}`}
                value={value[direction][key]} required={value.enabled}
                onChange={event => onChange({ ...value, [direction]: { ...value[direction], [key]: event.target.value } })}
              />)}
            </div>;
          })}
        </div>
        <p className="grade-definition">
          <span className="grade-guide" title="Approximate slope descriptions; overall effort also depends on distance and terrain. Grade alone does not establish scrambling.">
            <span>5–10% moderate</span><span>10–15% steep</span>
            <span>15–20% very steep</span><span>{">20% extreme"}</span>
          </span>
          Grade averaged over 100 m.
        </p>
      </div>}
    </div>
  );
}
