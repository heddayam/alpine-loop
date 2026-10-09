import { useId } from "react";
import { unitsFor, type UnitSystem } from "./units.js";
import { SteppedNumber } from "./SteppedNumber.js";
import { useAnchoredPopover } from "./useAnchoredPopover.js";
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
  const popover = useAnchoredPopover(disabled);
  const id = useId();
  const unit = unitsFor(units).distanceLabel;
  return (
    <div className="grade-limits" ref={popover.root} onBlur={popover.onBlur}>
      <div className={`grade-trigger${value.enabled ? " enabled" : ""}`}>
        <input type="checkbox" aria-label="Enable grade limits" checked={value.enabled}
          disabled={disabled} onChange={event => onChange({ ...value, enabled: event.target.checked })} />
        <button ref={popover.button} type="button" disabled={disabled} aria-expanded={popover.open}
          aria-controls={`${id}-panel`} onClick={popover.toggle}>
          Grade limits <span aria-hidden="true">▾</span>
        </button>
      </div>
      {popover.open && <div ref={popover.panel} className="grade-popover" style={{ left: popover.offset }} id={`${id}-panel`} role="group" aria-label="Grade limits settings">
        <div className="grade-grid">
          <span />
          <span className="grade-column" title="The distance limits apply to slopes steeper than this grade.">Max grade <span className="field-unit">%</span></span>
          <span className="grade-column">Total allowed <span className="field-unit">{unit}</span></span>
          <span className="grade-column">Longest stretch <span className="field-unit">{unit}</span></span>
          {(["uphill", "downhill"] as const).map(direction => {
            const label = direction === "uphill" ? "Uphill" : "Downhill";
            return <div className="grade-row" key={direction}>
              <span className="grade-direction">{label}</span>
              {(["above", "total", "longest"] as const).map(key => <SteppedNumber
                key={key} step={key === "above" ? 1 : 0.1}
                label={`${label} ${key === "above" ? "maximum grade (%)" : `${key === "total" ? "total allowed" : "longest stretch"} (${unit})`}`}
                value={value[direction][key]} required={value.enabled}
                onChange={text => onChange({ ...value, [direction]: { ...value[direction], [key]: text } })}
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
