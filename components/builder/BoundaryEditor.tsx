import type { Bounds } from "./types";

type BoundaryEditorProps = {
  bounds: Bounds;
  onChange: (bounds: Bounds) => void;
};

const LABELS = ["West longitude", "South latitude", "East longitude", "North latitude"] as const;

export function BoundaryEditor({ bounds, onChange }: BoundaryEditorProps) {
  return (
    <details className="boundary-editor">
      <summary>Edit boundary coordinates</summary>
      <p>Every generated route must remain inside these coordinates.</p>
      <div className="coordinate-grid">
        {bounds.map((value, index) => (
          <label key={LABELS[index]}>
            {LABELS[index]}
            <input
              type="number"
              step="0.0001"
              value={value}
              onChange={(event) => {
                const next = [...bounds] as Bounds;
                next[index] = Number(event.currentTarget.value);
                onChange(next);
              }}
            />
          </label>
        ))}
      </div>
    </details>
  );
}
