"use client";

import { useEffect, useRef, useState } from "react";
import type { GradePresetId, GradePresets } from "@/lib/contracts";

const PRESETS: GradePresetId[] = ["gentle", "moderate", "steep"];

function presetLabel(id: GradePresetId) {
  return id[0]!.toUpperCase() + id.slice(1);
}

type GradePresetInputProps = {
  disabled?: boolean;
  enabled: boolean;
  selected: GradePresetId;
  presets: GradePresets;
  onEnabledChange: (enabled: boolean) => void;
  onSelectedChange: (selected: GradePresetId) => void;
};

export function GradePresetInput({ disabled = false, enabled, selected, presets, onEnabledChange, onSelectedChange }: GradePresetInputProps) {
  const [pinned, setPinned] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pinned) return;
    const dismiss = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setPinned(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [pinned]);

  return (
    <fieldset className="range-field grade-preset-field" disabled={disabled}>
      <legend className="range-field-legend">Grade preset</legend>
      <div className="grade-preset-row">
        <div className="grade-label-wrap">
          <label className="range-toggle">
            <input type="checkbox" checked={enabled} onChange={(event) => onEnabledChange(event.currentTarget.checked)} />
            <span>Grade</span>
          </label>
          <div ref={rootRef} className={pinned ? "grade-info is-open" : "grade-info"}>
            <button
              type="button"
              className="grade-info-button"
              aria-label="Grade preset definitions"
              aria-expanded={pinned}
              onClick={(event) => {
                if (pinned) event.currentTarget.blur();
                setPinned((current) => !current);
              }}
            >i</button>
            <div className="grade-info-popover" role="tooltip">
              <table>
                <thead><tr><th>Preset</th><th>↑p90</th><th>&gt;10%</th><th>Run</th><th>↓p90</th></tr></thead>
                <tbody>{PRESETS.map((id) => {
                  const value = presets[id];
                  return <tr key={id}><th>{presetLabel(id)}</th><td>{value.maximumClimbP90Pct}%</td><td>{value.maximumSteepClimbingSharePct}%</td><td>{value.maximumSteepRunMiles} mi</td><td>{value.maximumDescentP90Pct}%</td></tr>;
                })}</tbody>
              </table>
            </div>
          </div>
        </div>
        <select
          aria-label="Grade preset"
          value={selected}
          disabled={!enabled}
          onChange={(event) => onSelectedChange(event.currentTarget.value as GradePresetId)}
        >
          {PRESETS.map((id) => <option key={id} value={id}>{presetLabel(id)}</option>)}
        </select>
        <output aria-label="Selected climbing grade">{presets[selected].maximumClimbP90Pct}%</output>
      </div>
    </fieldset>
  );
}
