import type { RangeField } from "./types";

type RangeInputProps = {
  id: string;
  label: string;
  unit: string;
  optional?: boolean;
  value: RangeField;
  onChange: (value: RangeField) => void;
};

export function RangeInput({ id, label, unit, optional = true, value, onChange }: RangeInputProps) {
  const enabled = optional ? value.enabled : true;
  return (
    <fieldset className="range-field">
      <legend>
        {optional ? (
          <label className="range-toggle">
            <input
              type="checkbox"
              checked={value.enabled}
              onChange={(event) => onChange({ ...value, enabled: event.currentTarget.checked })}
            />
            {label}
          </label>
        ) : label}
        <span>{unit}</span>
      </legend>
      <div className="range-row">
        <label htmlFor={`${id}-min`}>Minimum</label>
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
        <span aria-hidden="true">to</span>
        <label htmlFor={`${id}-max`}>Maximum</label>
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
      </div>
    </fieldset>
  );
}
