"use client";

import { useEffect, useRef, useState } from "react";
import { appSettingsV1Schema, type AppSettingsV1, type GradePresetId } from "@/lib/contracts";

type SettingsModalProps = {
  open: boolean;
  settings: AppSettingsV1;
  onSave: (settings: AppSettingsV1) => Promise<boolean>;
  onClose: () => void;
};

export function SettingsModal({
  open,
  settings,
  onSave,
  onClose,
}: SettingsModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const [draft, setDraft] = useState(settings);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "error">("idle");

  useEffect(() => {
    if (!open) return;
    previouslyFocusedRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const dialog = dialogRef.current;
    dialog?.querySelector<HTMLElement>("button, input, select")?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])',
      )];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previouslyFocusedRef.current?.focus();
    };
  }, [onClose, open]);

  if (!open) return null;

  const updatePreset = (id: GradePresetId, field: keyof AppSettingsV1["gradePresets"][GradePresetId], value: number) => {
    setDraft((current) => ({ ...current, gradePresets: { ...current.gradePresets, [id]: { ...current.gradePresets[id], [field]: value } } }));
  };

  const save = async () => {
    const parsed = appSettingsV1Schema.safeParse(draft);
    if (!parsed.success) { setSaveState("error"); return; }
    setSaveState("saving");
    if (await onSave(parsed.data)) onClose();
    else setSaveState("error");
  };

  return (
    <div
      className="settings-backdrop"
      onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}
    >
      <div
        ref={dialogRef}
        className="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        aria-describedby="settings-description"
      >
        <header className="settings-modal-heading">
          <h2 id="settings-title">Settings</h2>
          <button type="button" className="settings-close" aria-label="Close settings" onClick={onClose}>×</button>
        </header>

        <div className="settings-modal-content">
          <p id="settings-description" className="visually-hidden">
            Preferences controlling which trailheads appear and how broadly each route search runs.
          </p>

          <section className="settings-group" aria-labelledby="search-settings-title">
            <div className="settings-group-heading"><h3 id="search-settings-title">Search &amp; results</h3></div>
            <label className="switch-row" title="May use trailheads or trails without confirmed public access.">
              <span>Include uncertain trail access</span>
              <input
                type="checkbox"
                role="switch"
                checked={draft.includeUncertainAccess}
                onChange={(event) => setDraft((current) => ({ ...current, includeUncertainAccess: event.currentTarget.checked }))}
              />
            </label>
            <div className="count-field">
              <label htmlFor="settings-route-count">Quick-search routes</label>
              <input
                id="settings-route-count"
                type="number"
                min="1"
                max="20"
                value={draft.quickSearchRouteCount}
                onChange={(event) => setDraft((current) => ({ ...current, quickSearchRouteCount: Number(event.currentTarget.value) }))}
              />
              <small>1 to 20 alternatives</small>
            </div>
          </section>

          <section className="settings-group" aria-labelledby="grade-preset-settings-title">
            <div className="settings-group-heading"><h3 id="grade-preset-settings-title">Grade presets</h3></div>
            <div className="grade-preset-editor">
              <div className="grade-preset-editor-head" aria-hidden="true"><span>Preset</span><span>↑p90</span><span>&gt;10%</span><span>Run mi</span><span>↓p90</span></div>
              {(["gentle", "moderate", "steep"] as const).map((id) => {
                const preset = draft.gradePresets[id];
                const label = id[0]!.toUpperCase() + id.slice(1);
                return <fieldset key={id}><legend>{label}</legend><strong>{label}</strong>
                  <input aria-label={`${label} climb grade`} type="number" min="0" max="100" step="any" value={preset.maximumClimbP90Pct} onChange={(event) => updatePreset(id, "maximumClimbP90Pct", Number(event.currentTarget.value))} />
                  <input aria-label={`${label} steep climbing share`} type="number" min="0" max="100" step="any" value={preset.maximumSteepClimbingSharePct} onChange={(event) => updatePreset(id, "maximumSteepClimbingSharePct", Number(event.currentTarget.value))} />
                  <input aria-label={`${label} longest steep run`} type="number" min="0" max="30" step="any" value={preset.maximumSteepRunMiles} onChange={(event) => updatePreset(id, "maximumSteepRunMiles", Number(event.currentTarget.value))} />
                  <input aria-label={`${label} descent grade`} type="number" min="0" max="100" step="any" value={preset.maximumDescentP90Pct} onChange={(event) => updatePreset(id, "maximumDescentP90Pct", Number(event.currentTarget.value))} />
                </fieldset>;
              })}
            </div>
            <dl className="grade-preset-definitions">
              <div><dt>↑p90</dt><dd>90% of uphill 100 m windows are at or below this grade.</dd></div>
              <div><dt>&gt;10%</dt><dd>Maximum share of uphill-window distance at 10% grade or steeper.</dd></div>
              <div><dt>Run mi</dt><dd>Longest uninterrupted distance at 10% grade or steeper, in miles, before the trail eases below 10%.</dd></div>
              <div><dt>↓p90</dt><dd>90% of downhill 100 m windows are at or below this absolute grade.</dd></div>
            </dl>
          </section>
        </div>

        <footer className="settings-modal-footer">
          {saveState === "error" ? <p className="settings-save-error" role="alert">Settings could not be saved. Check the values and try again.</p> : null}
          <button type="button" className="btn btn-primary" disabled={saveState === "saving"} onClick={() => void save()}>{saveState === "saving" ? "Saving…" : "Done"}</button>
        </footer>
      </div>
    </div>
  );
}
