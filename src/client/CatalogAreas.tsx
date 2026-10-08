import type { CatalogView, SectionView, UnavailableSection } from "../data-format.js";

export const size = (bytes: number) => {
  const unit = bytes >= 1_000_000_000 ? "GB" : bytes >= 1_000_000 ? "MB" : "KB";
  const divisor = unit === "GB" ? 1_000_000_000 : unit === "MB" ? 1_000_000 : 1_000;
  return `${(bytes / divisor).toLocaleString(undefined, { maximumFractionDigits: 1 })} ${unit}`;
};
const stateNames: Record<string, string> = { WA: "Washington", CA: "California" };
type Range = {
  id: string; name: string;
  sections: SectionView[]; unavailable: UnavailableSection[];
};

function states(dataset: CatalogView) {
  const groups = new Map<string, Map<string, Range>>();
  for (const area of [...dataset.sections, ...(dataset.unavailable ?? [])]) {
    let ranges = groups.get(area.state);
    if (!ranges) groups.set(area.state, ranges = new Map());
    let range = ranges.get(area.regionId);
    if (!range) {
      range = { id: area.regionId, name: area.regionName, sections: [], unavailable: [] };
      ranges.set(area.regionId, range);
    }
    if ("files" in area) range.sections.push(area);
    else range.unavailable.push(area);
  }
  return [...groups].map(([code, ranges]) => ({
    code, name: stateNames[code] ?? code,
    ranges: [...ranges.values()].sort((a, b) => a.name.localeCompare(b.name)),
  })).sort((a, b) => a.name.localeCompare(b.name));
}

/** One geography, row and bulk-selection policy for search and download management. */
export function CatalogAreas({ dataset, value, onChange, disabled = false, purpose = "search" }: {
  dataset: CatalogView;
  value: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
  purpose?: "search" | "download";
}) {
  const download = purpose === "download";
  const update = (ids: string[], checked: boolean) => {
    if (!disabled) {
      onChange(checked ? [...new Set([...value, ...ids])] : value.filter(id => !ids.includes(id)));
    }
  };
  const selectable = (sections: SectionView[]) => sections
    .filter(section => !download || !section.installed).map(section => section.id);
  const bulk = (ids: string[]) => {
    const all = ids.every(id => value.includes(id));
    return ids.length > 1 && (
      <button type="button" disabled={disabled} onClick={() => update(ids, !all)}>
        {all ? "Clear" : "Select all"}
      </button>
    );
  };
  const rows = (range: Range) => <>
    {range.sections.map(section => {
      const ready = download && section.installed;
      const Row = ready ? "div" : "label";
      return (
        <Row className={`area-row${ready ? " area-ready" : ""}`} key={section.id} title={section.description}>
          {ready ? <span aria-hidden="true">✓</span> : (
            <input type="checkbox" checked={value.includes(section.id)} disabled={disabled}
              aria-label={`${download ? "Download " : ""}${section.name}`}
              onChange={event => update([section.id], event.target.checked)} />
          )}
          <span>{section.name}</span>
          {download && (
            <span className="area-status">
              {ready ? "Ready" : `${section.needsRepair ? "Repair, " : ""}${size(section.bytes)}`}
            </span>
          )}
        </Row>
      );
    })}
    {range.unavailable.map((section, index) => (
      <div className="area-row unavailable" key={`${section.name}-${index}`} title={section.reason}>
        <span aria-hidden="true">—</span>
        <span>{section.name}</span>
        <span className="area-status">Unavailable</span>
      </div>
    ))}
  </>;
  return (
    <div className={`catalog-areas catalog-${purpose}`}>
      {states(dataset).map(state => (
        <section className="area-state" key={state.code} aria-label={state.name}>
          <header>
            <h4>{state.name}</h4>
            {bulk(selectable(state.ranges.flatMap(range => range.sections)))}
          </header>
          {state.ranges.map(range => range.sections.length + range.unavailable.length > 1 ? (
            <section className="area-range" key={range.id} aria-label={range.name}>
              <header>
                <h5>{range.name}</h5>
                {bulk(selectable(range.sections))}
              </header>
              {rows(range)}
            </section>
          ) : <div key={range.id}>{rows(range)}</div>)}
        </section>
      ))}
    </div>
  );
}
