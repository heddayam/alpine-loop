import { useEffect, useId, useRef, useState } from "react";
import "./drive-time.css";
import { useAnchoredPopover } from "./useAnchoredPopover.js";

export type DriveTimeDraft = {
  enabled: boolean;
  minutes: string;
  /** Longitude, latitude. */
  origin?: [number, number];
};

export function DriveTimeControl({ value, onChange, disabled, available, choosingOrigin, returnFromMap, onChooseOrigin }: {
  value: DriveTimeDraft;
  onChange: (value: DriveTimeDraft) => void;
  disabled: boolean;
  available: boolean;
  choosingOrigin: boolean;
  returnFromMap: number;
  onChooseOrigin: () => void;
}) {
  const id = useId();
  const popover = useAnchoredPopover(disabled);
  const latest = useRef({ value, onChange, disabled, available });
  latest.current = { value, onChange, disabled, available };
  const request = useRef(0);
  const [locating, setLocating] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => () => { request.current++; }, []);
  useEffect(() => {
    if (returnFromMap && value.enabled && available && !disabled) {
      popover.show();
      popover.button.current?.focus();
    }
  }, [returnFromMap]);
  useEffect(() => {
    if (disabled || !available || !value.enabled) {
      request.current++;
      setLocating(false);
      setError("");
    }
  }, [disabled, available, value.enabled]);

  const change = (patch: Partial<DriveTimeDraft>) => {
    const next = { ...latest.current.value, ...patch };
    latest.current.value = next;
    latest.current.onChange(next);
  };
  const useLocation = () => {
    setError("");
    change({ enabled: true });
    if (!navigator.geolocation) {
      setError("Your browser cannot find your location. Choose on map instead.");
      return;
    }
    // A search must not reuse the old origin while a replacement is pending.
    change({ origin: undefined });
    const token = ++request.current;
    setLocating(true);
    const current = () => token === request.current && latest.current.value.enabled &&
      !latest.current.disabled && latest.current.available;
    navigator.geolocation.getCurrentPosition(position => {
      if (!current()) return;
      setLocating(false);
      change({ origin: [position.coords.longitude, position.coords.latitude] });
    }, failure => {
      if (!current()) return;
      setLocating(false);
      setError(failure.code === 1
        ? "Location access was denied. Choose on map instead."
        : failure.code === 3
          ? "Finding your location took too long. Try again or choose on map."
          : "Your location could not be found. Try again or choose on map.");
    }, { timeout: 12000, maximumAge: 60000 });
  };

  return <div className="drive-control" ref={popover.root} onBlur={popover.onBlur}
    title={!available ? "Driving filter is temporarily unavailable." : undefined}>
    <span className="field-label">Driving time</span>
    <div className={`drive-trigger${value.enabled ? " drive-enabled" : ""}`}>
      <input type="checkbox" aria-label="Enable driving time filter" checked={value.enabled}
        disabled={disabled || choosingOrigin || !available && !value.enabled}
        onChange={event => {
          change({ enabled: event.target.checked });
          if (event.target.checked && !popover.open) popover.toggle();
        }} />
      <button ref={popover.button} type="button" disabled={disabled || choosingOrigin || !available}
        aria-label={`Driving time, ${value.enabled ? value.origin ? `${value.minutes || "—"} min` : "choose location" : "off"}`}
        aria-expanded={popover.open} aria-controls={`${id}-panel`} onClick={popover.toggle}>
        {value.enabled ? value.origin ? `${value.minutes || "—"} min` : "Choose origin" : "Off"}
        <span aria-hidden="true">▾</span>
      </button>
    </div>
    {popover.open && available && <div ref={popover.panel} id={`${id}-panel`} className="drive-popover"
      style={{ left: popover.offset }} role="group" aria-label="Driving time settings">
      <fieldset className="drive-fields" disabled={disabled}>
      <div className="drive-duration">
        <label htmlFor={`${id}-minutes`}>Within</label>
        <input id={`${id}-minutes`} type="number" min={5} max={240} step="any" required={value.enabled} disabled={!value.enabled}
          aria-label="Maximum driving time in minutes" value={value.minutes}
          onChange={event => change({ minutes: event.target.value })}
          onKeyDown={event => {
            if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
            event.preventDefault();
            const number = Number(latest.current.value.minutes);
            change({ minutes: String(Math.min(240, Math.max(5,
              (Number.isFinite(number) ? number : 60) + (event.key === "ArrowUp" ? 15 : -15)))) });
          }} />
        <span>min <span className="drive-note">(5–240)</span></span>
      </div>
      <span className="drive-note">Drive from</span>
      <div className="drive-origin-actions">
        <button type="button" disabled={locating} aria-pressed={choosingOrigin}
          onClick={() => { setError(""); change({ enabled: true }); popover.hide(); onChooseOrigin(); }}>
          {choosingOrigin ? "Cancel map selection" : value.origin ? "Change on map" : "Choose on map"}
        </button>
        <button type="button" disabled={locating || choosingOrigin} onClick={useLocation}>
          {locating ? "Finding location…" : "Use my location"}
        </button>
      </div>
      <p className="drive-note" role="status">
        {locating ? "Finding your starting location…" : choosingOrigin ? "Click the map to choose a starting location."
          : value.origin ? `From ${value.origin[1].toFixed(4)}, ${value.origin[0].toFixed(4)}`
            : "Choose a starting location."}
      </p>
      {error && <p className="drive-error" role="alert">{error}</p>}
      <p className="drive-note">Estimated driving time, no live traffic.</p>
      </fieldset>
    </div>}
  </div>;
}
