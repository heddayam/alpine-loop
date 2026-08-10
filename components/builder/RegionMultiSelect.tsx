"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";

export type RegionOptionGroup = {
  packId: string;
  label: string;
  state: "loading" | "ready" | "error";
  error?: string;
  options: Array<{ id: string; name: string }>;
};

type RegionMultiSelectProps = {
  groups: RegionOptionGroup[];
  selected: Readonly<Record<string, readonly string[]>>;
  onChange: (packId: string, regionIds: string[]) => void;
  disabled?: boolean;
};

export function RegionMultiSelect({ groups, selected, onChange, disabled = false }: RegionMultiSelectProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  const selectedOptions = useMemo(
    () => groups.flatMap((group) => {
      const selectedIds = new Set(selected[group.packId] ?? []);
      return group.options.filter((option) => selectedIds.has(option.id));
    }),
    [groups, selected],
  );
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

  const updateGroup = (group: RegionOptionGroup, optionId: string, checked: boolean) => {
    const nextSelected = new Set(selected[group.packId] ?? []);
    if (checked) nextSelected.add(optionId);
    else nextSelected.delete(optionId);
    onChange(
      group.packId,
      group.options.filter((option) => nextSelected.has(option.id)).map((option) => option.id),
    );
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
          {groups.map((group) => (
            <fieldset key={group.packId} className="region-multiselect-group">
              <legend className="region-multiselect-group-heading">{group.label}</legend>
              {group.state === "loading" ? (
                <p className="region-multiselect-status" role="status">Loading regions…</p>
              ) : group.state === "error" ? (
                <p className="region-multiselect-error" role="alert">{group.error || "Regions unavailable."}</p>
              ) : group.options.length === 0 ? (
                <p className="region-multiselect-status">No regions available.</p>
              ) : (
                group.options.map((option) => (
                  <label key={option.id} className="region-multiselect-option">
                    <input
                      type="checkbox"
                      checked={(selected[group.packId] ?? []).includes(option.id)}
                      onChange={(event) => updateGroup(group, option.id, event.currentTarget.checked)}
                    />
                    <span>{option.name}</span>
                  </label>
                ))
              )}
            </fieldset>
          ))}
        </div>
      ) : null}
    </div>
  );
}
