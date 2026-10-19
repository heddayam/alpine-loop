import { useRef } from "react";

export function SteppedNumber({
  id,
  label,
  bound,
  value,
  step,
  max,
  min = 0,
  placeholder,
  required = true,
  onChange,
}: {
  id?: string;
  label: string;
  bound?: "Min" | "Max";
  value: string;
  step: number;
  max?: number;
  min?: number | null;
  placeholder?: string;
  required?: boolean;
  onChange: (value: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const number = Number(value) || 0;
  const adjust = (direction: number) => {
    input.current?.focus();
    const next = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, number + direction * step));
    // Keep fractional steps free of visible floating-point tails.
    onChange(String(step < 1 ? Number(next.toFixed(10)) : next));
  };
  return (
    <span className="stepped-number">
      {bound && <span className="input-bound" aria-hidden="true">{bound}</span>}
      <input
        ref={input}
        id={id}
        aria-label={label}
        type="number"
        min={min ?? undefined}
        placeholder={placeholder}
        max={max}
        step="any"
        required={required}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            adjust(event.key === "ArrowUp" ? 1 : -1);
          }
        }}
      />
      <span className="number-steppers">
        <button
          type="button"
          tabIndex={-1}
          aria-label={`Increase ${label.toLowerCase()} by ${step}`}
          disabled={max !== undefined && number >= max}
          onClick={() => adjust(1)}
        >
          <span className="step-arrow up" aria-hidden="true" />
        </button>
        <button
          type="button"
          tabIndex={-1}
          aria-label={`Decrease ${label.toLowerCase()} by ${step}`}
          disabled={min !== null && number <= min}
          onClick={() => adjust(-1)}
        >
          <span className="step-arrow down" aria-hidden="true" />
        </button>
      </span>
    </span>
  );
}
