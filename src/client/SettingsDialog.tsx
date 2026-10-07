import { useEffect, useRef, useState } from "react";
import type { CatalogView, DownloadSnapshot } from "../data-format.js";
import { boundaryLabel, groupedCatalog, regionLabel, sectionLabel } from "./RegionPicker.js";

const size = (bytes: number) => {
  const unit = bytes >= 1_000_000_000 ? "GB" : bytes >= 1_000_000 ? "MB" : "KB";
  const divisor = unit === "GB" ? 1_000_000_000 : unit === "MB" ? 1_000_000 : 1_000;
  return `${(bytes / divisor).toLocaleString(undefined, { maximumFractionDigits: 1 })} ${unit}`;
};

export function SettingsDialog({
  open,
  dataset,
  download,
  downloadError,
  busy,
  onClose,
  onDownload,
  onStopDownload,
  onRetryDownload,
  onDismissDownload,
}: {
  open: boolean;
  dataset?: CatalogView;
  download: DownloadSnapshot | null;
  downloadError: string;
  busy: boolean;
  onClose: () => void;
  onDownload: (ids: string[]) => void;
  onStopDownload: () => void;
  onRetryDownload: () => void;
  onDismissDownload: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const downloading = download?.status === "running";
  const locked = busy || downloading;
  const groups = dataset ? groupedCatalog(dataset) : [];
  const missing = dataset?.sections.filter((section) => !section.installed) ?? [];
  const chosen = missing.filter((section) => selected.includes(section.id));
  const update = (ids: string[], checked: boolean) => {
    if (!locked) setSelected((value) => checked ? [...new Set([...value, ...ids])] : value.filter((id) => !ids.includes(id)));
  };
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
    return () => {
      dialog.current?.close();
      if (previous?.isConnected) previous.focus();
      else document.getElementById("open-settings")?.focus();
    };
  }, [open]);
  useEffect(() => {
    if (!dataset) return;
    setSelected((value) => {
      const next = value.filter((id) => dataset.sections.some((section) => section.id === id && !section.installed));
      return next.length === value.length ? value : next;
    });
  }, [dataset]);

  return (
    <dialog
      ref={dialog}
      className="settings-modal"
      aria-labelledby="settings-title"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
    >
      <header className="dialog-heading">
        <h2 id="settings-title">Settings</h2>
        <button type="button" aria-label="Close settings" onClick={onClose}>×</button>
      </header>
      <div className="dialog-body">
        {download && (
          <section className="download-panel" aria-labelledby="settings-download-title" aria-busy={downloading || undefined}>
            <h3 id="settings-download-title">
              {downloading ? "Downloading trails" : download.status === "complete" ? "Download complete" : download.status === "stopped" ? "Download stopped" : "Download failed"}
            </h3>
            <p>{download.sections.map((id) => regionLabel(dataset?.sections.find((section) => section.id === id)?.name ?? id)).join(" · ")}</p>
            {downloading && (
              <>
                <progress
                  aria-label="Trail download progress"
                  value={Math.min(download.completedBytes, download.totalBytes)}
                  max={Math.max(1, download.totalBytes)}
                />
                <p>{size(download.completedBytes)} / {size(download.totalBytes)}</p>
              </>
            )}
            {download.reason && <p role={download.status === "failed" ? "alert" : undefined}>{download.reason}</p>}
            {downloadError && <p role="alert">{downloadError}</p>}
            <div className="download-actions">
              {downloading ? (
                <>
                  <button type="button" disabled={busy} onClick={onStopDownload}>Cancel download</button>
                  {downloadError && <button type="button" disabled={busy} onClick={onRetryDownload}>Reconnect</button>}
                </>
              ) : (
                <>
                  {(download.status === "failed" || download.status === "stopped") && (
                    <button type="button" disabled={busy} onClick={() => onDownload(download.sections)}>Retry download</button>
                  )}
                  <button type="button" disabled={busy} onClick={onDismissDownload}>Dismiss</button>
                </>
              )}
            </div>
          </section>
        )}
        <section aria-labelledby="trail-downloads-title">
          <h3 id="trail-downloads-title">Manage areas</h3>
          {!dataset && <p role="status">Opening trail data…</p>}
          {groups.map((group) => {
            const ids = group.sections.filter((section) => !section.installed).map((section) => section.id);
            const allSelected = ids.length > 0 && ids.every((id) => selected.includes(id));
            return (
              <section className="area-group" key={`${group.id}-${group.name}`} aria-label={group.name}>
                <header>
                  <h4>{group.name}</h4>
                  {!!ids.length && (
                    <button type="button" disabled={locked} onClick={() => update(ids, !allSelected)}>
                      {allSelected ? "Clear" : "Select all"}
                    </button>
                  )}
                </header>
                {group.sections.map((section) => section.installed ? (
                  <div className="area-row area-ready" key={section.id} title={boundaryLabel(section.name)}>
                    <span aria-hidden="true">✓</span>
                    <span>{sectionLabel(section.name)}</span>
                    <span className="area-status">Ready</span>
                  </div>
                ) : (
                  <label className="area-row" key={section.id} title={boundaryLabel(section.name)}>
                    <input
                      type="checkbox"
                      checked={selected.includes(section.id)}
                      disabled={locked}
                      aria-label={`Download ${regionLabel(section.name)}`}
                      onChange={(event) => update([section.id], event.target.checked)}
                    />
                    <span>{sectionLabel(section.name)}</span>
                    <span className="area-status">{section.needsRepair ? "Repair · " : ""}{size(section.bytes)}</span>
                  </label>
                ))}
                {group.unavailable.map((section, index) => (
                  <div className="area-row unavailable" key={`${section.name}-${index}`} title={section.reason}>
                    <span aria-hidden="true">—</span>
                    <span>{sectionLabel(section.name)}</span>
                    <span className="area-status">Unavailable</span>
                  </div>
                ))}
              </section>
            );
          })}
          {!!missing.length && (
            <div className="area-toolbar">
              <button
                type="button"
                className="primary"
                disabled={locked || !chosen.length}
                onClick={() => onDownload(chosen.map((section) => section.id))}
              >
                Download selected{chosen.length ? ` · ${size(chosen.reduce((bytes, section) => bytes + section.bytes, 0))}` : ""}
              </button>
              {!!chosen.length && <button type="button" disabled={locked} onClick={() => setSelected([])}>Clear</button>}
            </div>
          )}
        </section>
        {!download && downloadError && <p role="alert">{downloadError}</p>}
        {dataset && (
          <details className="settings-notes">
            <summary>About trail data</summary>
            <p>{dataset.name} · {dataset.sourceDate}</p>
            <p>Regions follow exact prepared GMBA mountain boundaries split at highways. Routes stay within each region.</p>
            <ul>{dataset.sections.map((section) => <li key={section.id}>{sectionLabel(section.name)}: {boundaryLabel(section.name)}</li>)}</ul>
            {!!dataset.limitations.length && <ul>{dataset.limitations.map((note) => <li key={note}>{note}</li>)}</ul>}
            {dataset.attribution.map((source) => (
              <p key={source.url}>
                <a href={source.url} target="_blank" rel="noreferrer">{source.name}</a>
                {" · "}{source.license}
              </p>
            ))}
          </details>
        )}
      </div>
    </dialog>
  );
}
