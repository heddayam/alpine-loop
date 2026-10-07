import { useEffect, useId, useRef } from "react";
import type { CatalogView, SectionView, UnavailableSection } from "../data-format.js";

const formatBoundary = (name: string) =>
  name
    .replace(/\bI(\d+)\b/g, "I-$1")
    .replace(/\bUS(\d+)\b/g, "US $1")
    .replace(/\bWA(\d+)\b/g, "SR $1")
    .replace(/,\s*/g, " · ")
    .replace(/^[a-z]/, (letter) => letter.toUpperCase());

export const boundaryLabel = (name: string) =>
  formatBoundary(name.includes(" — ") ? name.slice(name.indexOf(" — ") + 3) : name);

const washingtonAreas: Record<string, string> = {
  "north of i-90 · south of us 2": "Alpine Lakes",
  "north of i-90 · north of us 2 · south of sr 20": "Glacier Peak & Mountain Loop",
  "north of i-90 · north of us 2 · north of sr 20": "Mount Baker & North Cascades",
  "south of i-90 · north of us 12": "Mount Rainier & Central Cascades",
  "south of i-90 · south of us 12": "Mount St. Helens & Mount Adams",
};

export const sectionLabel = (name: string) => {
  const boundary = boundaryLabel(name);
  return name.startsWith("Washington Cascades — ")
    ? washingtonAreas[boundary.toLowerCase().trim().replace(/\s+/g, " ")] ?? boundary
    : boundary;
};

export const regionLabel = (name: string) => {
  const label = sectionLabel(name);
  return label === boundaryLabel(name) ? formatBoundary(name) : `${name.split(" — ")[0]} — ${label}`;
};

type RegionGroup = {
  id: string;
  name: string;
  sections: SectionView[];
  unavailable: UnavailableSection[];
};

export function groupedCatalog(dataset: CatalogView): RegionGroup[] {
  const groups: RegionGroup[] = [];
  const parentName = (name: string) => name.split(" — ")[0]!;
  for (const section of dataset.sections) {
    const name = parentName(section.name);
    let group = groups.find((item) => item.id === section.regionId && item.name === name);
    if (!group) {
      group = { id: section.regionId, name, sections: [], unavailable: [] };
      groups.push(group);
    }
    group.sections.push(section);
  }
  for (const unavailable of dataset.unavailable ?? []) {
    const name = parentName(unavailable.name);
    let group = groups.find((item) => item.name === name);
    if (!group) {
      group = { id: `unavailable-${name}`, name, sections: [], unavailable: [] };
      groups.push(group);
    }
    group.unavailable.push(unavailable);
  }
  return groups;
}

export function RegionPicker({
  dataset,
  value,
  disabled = false,
  onChange,
}: {
  dataset: CatalogView;
  value: string[];
  disabled?: boolean;
  onChange: (ids: string[]) => void;
}) {
  const details = useRef<HTMLDetailsElement>(null);
  const summary = useRef<HTMLElement>(null);
  const id = useId();
  const groups = groupedCatalog(dataset);
  const unknown = value.filter((selected) => !dataset.sections.some((section) => section.id === selected));
  const selection = value.length === 1
    ? regionLabel(dataset.sections.find((section) => section.id === value[0])?.name ?? value[0]!)
    : value.length ? `${value.length} regions selected` : "Select regions";
  const update = (ids: string[], selected: boolean) => {
    if (!disabled) onChange(selected ? [...new Set([...value, ...ids])] : value.filter((item) => !ids.includes(item)));
  };
  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !details.current?.contains(event.target) && details.current) {
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
        if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) {
          event.currentTarget.open = false;
        }
      }}
    >
      <summary
        ref={summary}
        className="region-summary"
        aria-label={`Search regions: ${selection}`}
        aria-disabled={disabled || undefined}
        aria-controls={`${id}-regions`}
        tabIndex={disabled ? -1 : 0}
        onClick={(event) => { if (disabled) event.preventDefault(); }}
        onKeyDown={(event) => {
          if (disabled && (event.key === "Enter" || event.key === " ")) event.preventDefault();
        }}
      >
        <span>{selection}</span>
      </summary>
      <div id={`${id}-regions`} className="region-dropdown">
        {groups.map((group) => {
          const ids = group.sections.map((section) => section.id);
          const allSelected = ids.length > 0 && ids.every((section) => value.includes(section));
          return (
            <section className="region-group" key={`${group.id}-${group.name}`} aria-label={group.name}>
              <header>
                <h3>{group.name}</h3>
                {!!ids.length && (
                  <button type="button" disabled={disabled} onClick={() => update(ids, !allSelected)}>
                    {allSelected ? "Clear" : "Select all"}
                  </button>
                )}
              </header>
              {group.sections.map((section) => (
                <label className="region-option" key={section.id} title={boundaryLabel(section.name)}>
                  <input
                    type="checkbox"
                    checked={value.includes(section.id)}
                    disabled={disabled}
                    aria-label={regionLabel(section.name)}
                    onChange={(event) => update([section.id], event.target.checked)}
                  />
                  <span>{sectionLabel(section.name)}</span>
                </label>
              ))}
              {group.unavailable.map((section, index) => (
                <label className="region-option unavailable" key={`${section.name}-${index}`} title={section.reason}>
                  <input type="checkbox" disabled aria-label={`${regionLabel(section.name)}: unavailable`} />
                  <span>{sectionLabel(section.name)}</span>
                  <small>Unavailable</small>
                </label>
              ))}
            </section>
          );
        })}
        {!!unknown.length && (
          <section className="region-group" aria-label="Unavailable selections">
            <header><h3>Unavailable selections</h3></header>
            {unknown.map((selected) => (
              <label className="region-option" key={selected}>
                <input type="checkbox" checked disabled={disabled} onChange={() => update([selected], false)} />
                <span>{selected}</span>
                <small>Unavailable</small>
              </label>
            ))}
          </section>
        )}
        {!groups.length && !unknown.length && <p>No search regions available.</p>}
      </div>
    </details>
  );
}
