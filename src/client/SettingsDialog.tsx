import { useEffect, useRef, useState } from "react";
import type { CatalogView, DownloadSnapshot } from "../data-format.js";
import type { UnitSystem } from "./units.js";
import { CatalogAreas, size } from "./CatalogAreas.js";

export function SettingsDialog({
  open,
  units,
  onUnits,
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
  units: UnitSystem;
  onUnits: (units: UnitSystem) => void;
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
  const missing =
    dataset?.sections.filter((section) => !section.installed) ?? [];
  const chosen = missing.filter((section) => selected.includes(section.id));
  useEffect(() => {
    if (!open) return;
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
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
      const next = value.filter((id) =>
        dataset.sections.some(
          (section) => section.id === id && !section.installed,
        ),
      );
      return next.length === value.length ? value : next;
    });
  }, [dataset]);

  return (
    <dialog
      ref={dialog}
      className="settings-modal"
      aria-labelledby="settings-title"
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right ||
            event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
      }}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header className="dialog-heading">
        <h2 id="settings-title">Settings</h2>
        <button type="button" aria-label="Close settings" onClick={onClose}>
          ×
        </button>
      </header>
      <div className="dialog-body">
        <fieldset className="unit-settings">
          <legend>Units</legend>
          <label>
            <input
              type="radio"
              name="units"
              value="imperial"
              checked={units === "imperial"}
              onChange={() => onUnits("imperial")}
            />
            Imperial <span>miles, feet</span>
          </label>
          <label>
            <input
              type="radio"
              name="units"
              value="metric"
              checked={units === "metric"}
              onChange={() => onUnits("metric")}
            />
            Metric <span>kilometers, meters</span>
          </label>
        </fieldset>
        {!dataset?.hosted && download && (
          <section
            className="download-panel"
            aria-labelledby="settings-download-title"
            aria-busy={downloading || undefined}
          >
            <h3 id="settings-download-title">
              {downloading
                ? "Downloading trails"
                : download.status === "complete"
                  ? "Download complete"
                  : download.status === "stopped"
                    ? "Download stopped"
                    : "Download failed"}
            </h3>
            <p>
              {download.sections
                .map((id) =>
                  dataset?.sections.find((section) => section.id === id)?.name ?? id,
                )
                .join(", ")}
            </p>
            {downloading && (
              <>
                <progress
                  aria-label="Trail download progress"
                  value={Math.min(download.completedBytes, download.totalBytes)}
                  max={Math.max(1, download.totalBytes)}
                />
                <p>
                  {size(download.completedBytes)} / {size(download.totalBytes)}
                </p>
              </>
            )}
            {download.reason && (
              <p role={download.status === "failed" ? "alert" : undefined}>
                {download.reason}
              </p>
            )}
            {downloadError && <p role="alert">{downloadError}</p>}
            <div className="download-actions">
              {downloading ? (
                <>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={onStopDownload}
                  >
                    Cancel download
                  </button>
                  {downloadError && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={onRetryDownload}
                    >
                      Reconnect
                    </button>
                  )}
                </>
              ) : (
                <>
                  {(download.status === "failed" ||
                    download.status === "stopped") && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => onDownload(download.sections)}
                    >
                      Retry download
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={onDismissDownload}
                  >
                    Dismiss
                  </button>
                </>
              )}
            </div>
          </section>
        )}
        {!dataset?.hosted && <section aria-labelledby="trail-downloads-title">
          <h3 id="trail-downloads-title">Manage areas</h3>
          {!dataset && <p role="status">Opening trail data…</p>}
          {dataset && <CatalogAreas dataset={dataset} value={selected} onChange={setSelected} disabled={locked} purpose="download" />}
          {!!missing.length && (
            <div className="area-toolbar">
              <button
                type="button"
                className="primary"
                disabled={locked || !chosen.length}
                onClick={() => onDownload(chosen.map((section) => section.id))}
              >
                Download selected
                {chosen.length
                  ? ` (${size(chosen.reduce((bytes, section) => bytes + section.bytes, 0))})`
                  : ""}
              </button>
              {!!chosen.length && (
                <button
                  type="button"
                  disabled={locked}
                  onClick={() => setSelected([])}
                >
                  Clear
                </button>
              )}
            </div>
          )}
        </section>}
        {!download && downloadError && <p role="alert">{downloadError}</p>}
        {dataset && (
          <details className="settings-notes">
            <summary>About trail data</summary>
            <p>
              {dataset.name}, {dataset.sourceDate}
            </p>
            <p>
              Routes stay within each area. Major highway boundaries exclude
              crossings, including bridges and underpasses.
            </p>
            <ul>
              {dataset.sections.filter(section => section.description).map((section) => (
                <li key={section.id}>
                  {section.name}: {section.description}
                </li>
              ))}
            </ul>
            {!!dataset.limitations.length && (
              <ul>
                {dataset.limitations.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            )}
            {dataset.attribution.map((source) => (
              <p key={source.url}>
                <a href={source.url} target="_blank" rel="noreferrer">
                  {source.name}
                </a>
                {", "}
                {source.license}
              </p>
            ))}
          </details>
        )}
      </div>
    </dialog>
  );
}
