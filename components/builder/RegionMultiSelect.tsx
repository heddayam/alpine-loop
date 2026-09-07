"use client";

import { useEffect, useId, useRef, useState } from "react";

type RegionMultiSelectProps = {
  options: Array<{ id: string; name: string }>;
  selected: readonly string[];
  onChange: (regionIds: string[]) => void;
  disabled?: boolean;
};

export function RegionMultiSelect({ options, selected, onChange, disabled = false }: RegionMultiSelectProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const selectedOptions = options.filter(({ id }) => selected.includes(id));
  const summary = selectedOptions.length === 0
    ? "Choose regions"
    : selectedOptions.length === 1
      ? selectedOptions[0]!.name
      : `${selectedOptions.length} regions selected`;

  useEffect(() => {
    if (!open) return;

    const dismissOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const dismissWithEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };

    document.addEventListener("pointerdown", dismissOutside);
    document.addEventListener("keydown", dismissWithEscape);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside);
      document.removeEventListener("keydown", dismissWithEscape);
    };
  }, [open]);

  const update = (optionId: string, checked: boolean) => {
    const next = new Set(selected);
    if (checked) next.add(optionId);
    else next.delete(optionId);
    onChange(options.filter(({ id }) => next.has(id)).map(({ id }) => id));
  };

  return (
    <div ref={rootRef} className="region-multiselect-root">
      <button
        ref={triggerRef}
        type="button"
        className="region-multiselect-trigger"
        aria-label={`Regions: ${summary}`}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-haspopup="true"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="region-multiselect-label">Regions</span>
        <span className="region-multiselect-summary">{summary}</span>
      </button>

      {open ? (
        <div id={panelId} className="region-multiselect-panel" role="group" aria-label="Region selection">
          {options.map((option) => (
            <label key={option.id} className="region-multiselect-option">
              <input type="checkbox" checked={selected.includes(option.id)} onChange={(event) => update(option.id, event.currentTarget.checked)} />
              <span>{option.name}</span>
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}
