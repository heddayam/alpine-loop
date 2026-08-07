import type { RangeField } from "./types";

type RangeInputProps = {
  id: string;
  label: string;
  unit: string;
  /** Spelled out on hover so the compact row can stay a single line. */
  title?: string;
  optional?: boolean;
  value: RangeField;
  onChange: (value: RangeField) => void;
};

export function RangeInput({ id, label, unit, title, optional = true, value, onChange }: RangeInputProps) {
  const enabled = optional ? value.enabled : true;
  return (
    <fieldset className="range-field">
      <legend className="range-field-legend">{label} range</legend>
      <div className="range-row" title={title}>
        <div className="range-label-cell">
          {optional ? (
            <label className="range-toggle">
              <input
                type="checkbox"
                checked={value.enabled}
                onChange={(event) => onChange({ ...value, enabled: event.currentTarget.checked })}
              />
              <span>{label}</span>
            </label>
          ) : <span className="range-label-text">{label}</span>}
        </div>
        <label className="range-value-cell" htmlFor={`${id}-min`}>
          <span>Minimum</span>
          <input
            id={`${id}-min`}
            name={`${id}Min`}
            type="number"
            aria-label={`${label} minimum`}
            min="0"
            step="any"
            inputMode="decimal"
            value={value.min}
            disabled={!enabled}
            onChange={(event) => onChange({ ...value, min: event.currentTarget.value })}
          />
        </label>
        <label className="range-value-cell" htmlFor={`${id}-max`}>
          <span>Maximum</span>
          <input
            id={`${id}-max`}
            name={`${id}Max`}
            type="number"
            aria-label={`${label} maximum`}
            min="0"
            step="any"
            inputMode="decimal"
            value={value.max}
            disabled={!enabled}
            onChange={(event) => onChange({ ...value, max: event.currentTarget.value })}
          />
        </label>
        <span className="range-unit-cell">{unit}</span>
      </div>
    </fieldset>
  );
}
