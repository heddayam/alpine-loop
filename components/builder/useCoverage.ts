"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { downloadCatalogSchema, downloadJobSchema, type DownloadCatalog, type DownloadJob, type DownloadRequest } from "@/lib/contracts/releases";

export const processingCoverage = (job: DownloadJob) => ["queued", "running", "pausing"].includes(job.status);
async function json(url: string, signal: AbortSignal, body?: unknown, method = "POST") {
  const response = await fetch(url, { signal, cache: "no-store", ...(body === undefined ? {} : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
  const payload = await response.json();
  if (!response.ok) throw new Error(typeof payload?.error === "string" ? payload.error : payload?.error?.message ?? "Coverage could not be updated.");
  return payload;
}

/** One cancellation scope prevents old polls from overwriting a download action. */
export function useCoverage(open: boolean) {
  const [catalog, setCatalog] = useState<DownloadCatalog>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const controller = useRef<AbortController | null>(null);
  const begin = useCallback(() => { controller.current?.abort(); const next = new AbortController(); controller.current = next; return next; }, []);
  const refresh = useCallback(async () => {
    const request = begin();
    try {
      const next = downloadCatalogSchema.parse(await json("/api/coverage", request.signal));
      if (!request.signal.aborted) { setCatalog(next); setBusy(false); setError(undefined); }
    } catch (failure) { if (!request.signal.aborted) setError(failure instanceof Error ? failure.message : "Coverage is unavailable."); }
  }, [begin]);
  useEffect(() => {
    if (!open) return;
    let active = true;
    queueMicrotask(() => { if (active) void refresh(); });
    return () => { active = false; controller.current?.abort(); };
  }, [open, refresh]);
  useEffect(() => {
    if (!open || busy || !catalog?.jobs.some(processingCoverage)) return;
    const timer = setTimeout(() => void refresh(), 2_000);
    return () => clearTimeout(timer);
  }, [open, busy, catalog, refresh]);
  const run = async (operation: (signal: AbortSignal) => Promise<void>) => {
    const request = begin(); setBusy(true); setError(undefined);
    try { await operation(request.signal); }
    catch (failure) { if (!request.signal.aborted) setError(failure instanceof Error ? failure.message : "Coverage could not be updated."); }
    finally { if (!request.signal.aborted) setBusy(false); }
  };
  const update = (url: string, body: unknown) => run(async (signal) => {
    const job = downloadJobSchema.parse(await json(url, signal, body));
    if (signal.aborted) return;
    setCatalog((current) => current ? { ...current, installed: job.installation ?? current.installed, jobs: [job, ...current.jobs.filter((item) => item.id !== job.id)] } : current);
  });
  return { catalog, busy, error, refresh,
    start: (request: DownloadRequest) => update("/api/coverage/jobs", request),
    act: (id: string, action: "pause" | "resume" | "cancel") => update(`/api/coverage/jobs/${encodeURIComponent(id)}/${action}`, {}),
    remove: (sectionIds: string[]) => run(async (signal) => {
      await json("/api/coverage", signal, { sectionIds }, "DELETE");
      const next = downloadCatalogSchema.parse(await json("/api/coverage", signal));
      if (!signal.aborted) setCatalog(next);
    }),
  };
}
