import { useEffect, useId, useRef } from "react";
import type { CatalogView } from "../data-format.js";
import type { SearchBoundary } from "../model.js";
import { CatalogAreas } from "./CatalogAreas.js";

export function RegionPicker({
  dataset,
  value,
  savedSections = [],
  disabled = false,
  onChange,
  boundary,
}: {
  dataset: CatalogView;
  value: string[];
  savedSections?: { id: string; name: string }[];
  disabled?: boolean;
  onChange: (ids: string[]) => void;
  boundary?: SearchBoundary;
}) {
  const details = useRef<HTMLDetailsElement>(null);
  const summary = useRef<HTMLElement>(null);
  const id = useId();
  const unknown = value.filter(
    (selected) => !dataset.sections.some((section) => section.id === selected),
  );
  const selection =
    boundary ? "Drawn area" : value.length === 1
      ? (dataset.sections.find((section) => section.id === value[0])?.name ??
          savedSections.find((section) => section.id === value[0])?.name ?? value[0]!)
      : value.length
        ? `${value.length} regions selected`
        : "Select regions";
  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !details.current?.contains(event.target) &&
        details.current
      ) {
        details.current.open = false;
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && details.current?.open) {
        event.preventDefault();
        details.current.open = false;
        summary.current?.focus();
      }
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, []);
  useEffect(() => {
    if (disabled && details.current) details.current.open = false;
  }, [disabled]);

  return (
    <details
      ref={details}
      className="region-picker"
      onBlur={(event) => {
        if (
          event.relatedTarget instanceof Node &&
          !event.currentTarget.contains(event.relatedTarget)
        ) {
          event.currentTarget.open = false;
        }
      }}
    >
      <summary
        ref={summary}
        className="region-summary"
        aria-label={`Search area: ${selection}`}
        aria-disabled={disabled || undefined}
        aria-controls={`${id}-regions`}
        tabIndex={disabled ? -1 : 0}
        onClick={(event) => {
          if (disabled) event.preventDefault();
        }}
        onKeyDown={(event) => {
          if (disabled && (event.key === "Enter" || event.key === " "))
            event.preventDefault();
        }}
      >
        <span>{selection}</span>
      </summary>
      <div id={`${id}-regions`} className="region-dropdown">
        <CatalogAreas dataset={dataset} value={value} disabled={disabled} onChange={onChange} />
        {!!unknown.length && (
          <section className="region-group" aria-label="Unavailable selections">
            <header>
              <h3>Unavailable selections</h3>
            </header>
            {unknown.map((selected) => (
              <label className="region-option" key={selected}>
                <input
                  type="checkbox"
                  checked
                  disabled={disabled}
                  onChange={() => { if (!disabled) onChange(value.filter(id => id !== selected)); }}
                />
                <span>
                  {savedSections.find((section) => section.id === selected)?.name ?? selected}
                </span>
                <small>Saved region unavailable</small>
              </label>
            ))}
          </section>
        )}
        {!dataset.sections.length && !dataset.unavailable?.length && !unknown.length && (
          <p>No search regions available.</p>
        )}
      </div>
    </details>
  );
}
