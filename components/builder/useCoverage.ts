"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { coverageCatalogSchema, coverageJobSchema, coveragePlanSchema, type CoverageAction, type CoverageCatalog, type CoverageJob, type CoveragePlan, type CoverageRequest } from "@/lib/contracts/coverage";

export const processingCoverage = (job: CoverageJob) => ["queued", "running", "pausing"].includes(job.status);

async function json(url: string, signal: AbortSignal, body?: unknown) {
  const response = await fetch(url, { signal, cache: "no-store", ...(body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
  const payload = await response.json();
  if (!response.ok) throw new Error(typeof payload?.error === "string" ? payload.error : payload?.error?.message ?? "Coverage could not be updated.");
  return payload;
}

/** Serialize snapshots and actions so an older poll cannot overwrite a mutation. */
export function useCoverage(open: boolean) {
  const [catalog, setCatalog] = useState<CoverageCatalog>();
  const [plan, setPlan] = useState<CoveragePlan>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const controller = useRef<AbortController | null>(null);
  const begin = useCallback(() => { controller.current?.abort(); const next = new AbortController(); controller.current = next; return next; }, []);
  const refresh = useCallback(async () => {
    const request = begin();
    try {
      const next = coverageCatalogSchema.parse(await json("/api/coverage", request.signal));
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
  const preview = (request: CoverageRequest) => run(async (signal) => {
    setPlan(undefined);
    const next = coveragePlanSchema.parse(await json("/api/coverage/plan", signal, request));
    if (!signal.aborted) setPlan(next);
  });
  const update = (url: string, body: unknown) => run(async (signal) => {
    const job = coverageJobSchema.parse(await json(url, signal, body));
    if (signal.aborted) return;
    setCatalog((current) => current ? { ...current, installed: job.snapshot ?? current.installed, jobs: [job, ...current.jobs.filter((item) => item.id !== job.id)] } : current);
    setPlan(undefined);
  });
  const clearPlan = useCallback(() => setPlan(undefined), []);
  return { catalog, plan, busy, error, refresh, clearPlan, preview,
    start: () => plan ? update("/api/coverage/jobs", { planId: plan.id }) : Promise.resolve(),
    act: (id: string, action: CoverageAction) => update(`/api/coverage/jobs/${encodeURIComponent(id)}/${action}`, {}),
  };
}
