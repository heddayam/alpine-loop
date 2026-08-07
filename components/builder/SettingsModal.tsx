"use client";

import { useEffect, useRef } from "react";
import type { AccessPointRemoteness } from "@/lib/contracts";

const ACCESS_POINT_OPTIONS: Array<{
  id: AccessPointRemoteness;
  label: string;
  description: string;
}> = [
  { id: "remote", label: "Remote", description: "Very low population near the access point." },
  { id: "rural", label: "Rural", description: "Low-density settlements and countryside." },
  { id: "populated", label: "Populated", description: "Town, neighborhood, and urban access." },
  { id: "unknown", label: "Unknown", description: "Population coverage is unavailable." },
];

type SettingsModalProps = {
  open: boolean;
  includeUncertainAccess: boolean;
  accessPointRemoteness: AccessPointRemoteness[];
  limit: string;
  onChange: (patch: {
    includeUncertainAccess?: boolean;
    accessPointRemoteness?: AccessPointRemoteness[];
    limit?: string;
  }) => void;
  onClose: () => void;
};

export function SettingsModal({
  open,
  includeUncertainAccess,
  accessPointRemoteness,
  limit,
  onChange,
  onClose,
}: SettingsModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

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

  const toggleRemoteness = (id: AccessPointRemoteness, checked: boolean) => {
    const next = checked
      ? ACCESS_POINT_OPTIONS.map(({ id: option }) => option).filter((option) =>
        option === id || accessPointRemoteness.includes(option))
      : accessPointRemoteness.filter((option) => option !== id);
    if (next.length > 0) onChange({ accessPointRemoteness: next });
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

          <section className="settings-group" aria-labelledby="access-point-settings-title">
            <div className="settings-group-heading">
              <h3 id="access-point-settings-title">Access point areas</h3>
              <span>{accessPointRemoteness.length} of {ACCESS_POINT_OPTIONS.length} shown</span>
            </div>
            <p>Only these area types appear on the map and start routes. &ldquo;Unknown&rdquo; means population data is missing, not uncertain trail access.</p>
            <div className="access-point-setting-grid">
              {ACCESS_POINT_OPTIONS.map((option) => {
                const checked = accessPointRemoteness.includes(option.id);
                return (
                  <label key={option.id} className={checked ? "selected" : ""}>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={checked && accessPointRemoteness.length === 1}
                      onChange={(event) => toggleRemoteness(option.id, event.currentTarget.checked)}
                    />
                    <span><strong>{option.label}</strong><small>{option.description}</small></span>
                  </label>
                );
              })}
            </div>
          </section>

          <section className="settings-group" aria-labelledby="search-settings-title">
            <div className="settings-group-heading"><h3 id="search-settings-title">Search &amp; results</h3></div>
            <label className="switch-row" title="May use trailheads or trails without confirmed public access.">
              <span>Include uncertain trail access</span>
              <input
                type="checkbox"
                role="switch"
                checked={includeUncertainAccess}
                onChange={(event) => onChange({ includeUncertainAccess: event.currentTarget.checked })}
              />
            </label>
            <div className="count-field">
              <label htmlFor="settings-route-count">Quick-search routes</label>
              <input
                id="settings-route-count"
                type="number"
                min="1"
                max="20"
                value={limit}
                onChange={(event) => onChange({ limit: event.currentTarget.value })}
              />
              <small>1 to 20 alternatives</small>
            </div>
          </section>
        </div>

        <footer className="settings-modal-footer">
          <button type="button" className="btn btn-primary" onClick={onClose}>Done</button>
        </footer>
      </div>
    </div>
  );
}
