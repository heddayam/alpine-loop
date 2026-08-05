import { useState } from "react";
import type { Bounds } from "./types";

type BoundaryEditorProps = {
  bounds: Bounds | null;
  onChange: (bounds: Bounds) => void;
};

const LABELS = ["West longitude", "South latitude", "East longitude", "North latitude"] as const;

export function BoundaryEditor({ bounds, onChange }: BoundaryEditorProps) {
  const [values, setValues] = useState<[string, string, string, string]>(() =>
    bounds ? bounds.map(String) as [string, string, string, string] : ["", "", "", ""],
  );
  return (
    <details className="boundary-editor" open={!bounds}>
      <summary>{bounds ? "Edit area coordinates" : "Enter area coordinates"}</summary>
      <p>Enter west, south, east, and north coordinates. Boundary points count as inside.</p>
      <div className="coordinate-grid">
        {values.map((value, index) => (
          <label key={LABELS[index]}>
            {LABELS[index]}
            <input
              type="number"
              step="0.0001"
              value={value}
              onChange={(event) => {
                const next = [...values] as [string, string, string, string];
                next[index] = event.currentTarget.value;
                setValues(next);
                const parsed = next.map(Number);
                if (parsed.every(Number.isFinite) && parsed[0]! < parsed[2]! && parsed[1]! < parsed[3]!) {
                  onChange(parsed as Bounds);
                }
              }}
            />
          </label>
        ))}
      </div>
    </details>
  );
}
