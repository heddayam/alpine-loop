"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { routeJobListV2Schema, type RouteJobV2 } from "@/lib/contracts/search";

export const ACTIVE_JOB_STATUSES = new Set<RouteJobV2["status"]>(["queued", "resolving-drive-time", "running"]);
const isPending = (job: RouteJobV2) => ACTIVE_JOB_STATUSES.has(job.status) || job.status === "deleting";
export type JobAction = "cancelling" | "deleting";

/** Own saved-work snapshots, serialized polling, and mutations. */
export function useJobs(open: boolean) {
  const [jobs, setJobs] = useState<RouteJobV2[]>([]);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string>();
  const [refreshedAt, setRefreshedAt] = useState<number>();
  const [pending, setPending] = useState<Record<string, JobAction>>({});
  const [announcement, setAnnouncement] = useState("");
  const latest = useRef(jobs);
  const inFlight = useRef<Promise<void> | null>(null);
  const controller = useRef<AbortController | null>(null);

  const refresh = useCallback(async (force = false): Promise<void> => {
    if (inFlight.current && !force) return inFlight.current;
    controller.current?.abort();
    const requestController = new AbortController();
    controller.current = requestController;
    const request = (async () => {
      try {
        const response = await fetch("/api/route-jobs", { cache: "no-store", signal: requestController.signal });
        if (!response.ok) throw new Error("Jobs could not be refreshed.");
        const next = routeJobListV2Schema.parse(await response.json()).jobs;
        if (requestController.signal.aborted) return;
        const finished = next.find((job) => !ACTIVE_JOB_STATUSES.has(job.status) && latest.current.some((previous) => previous.id === job.id && ACTIVE_JOB_STATUSES.has(previous.status)));
        if (finished) setAnnouncement(`${finished.area.label}: ${finished.status}.`);
        latest.current = next;
        setJobs(next);
        setPending((current) => Object.fromEntries(Object.entries(current).filter(([id, action]) =>
          next.some((job) => job.id === id && (action === "deleting" || ACTIVE_JOB_STATUSES.has(job.status))))));
        setRefreshedAt(Date.now());
        setLoadState("ready");
        setError(undefined);
      } catch (failure) {
        if (!requestController.signal.aborted) {
          setLoadState("error");
          setError(failure instanceof Error ? failure.message : "Jobs could not be refreshed.");
        }
      }
    })();
    inFlight.current = request;
    try { await request; }
    finally { if (inFlight.current === request) inFlight.current = null; }
  }, []);

  const active = jobs.some(isPending);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await refresh();
      if (!stopped && latest.current.some(isPending)) timer = setTimeout(() => void poll(), open ? 2_000 : 5_000);
    };
    if (active) timer = setTimeout(() => void poll(), open ? 2_000 : 5_000);
    const visible = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", visible);
    return () => { stopped = true; clearTimeout(timer); document.removeEventListener("visibilitychange", visible); };
  }, [active, open, refresh]);
  useEffect(() => { void refresh(true); return () => controller.current?.abort(); }, [refresh]);

  const mutate = async (id: string, action: "cancel" | "delete") => {
    setPending((current) => ({ ...current, [id]: action === "cancel" ? "cancelling" : "deleting" }));
    try {
      const response = await fetch(`/api/route-jobs/${id}${action === "cancel" ? "/cancel" : ""}`, { method: action === "cancel" ? "POST" : "DELETE" });
      if (!response.ok) throw new Error(`Job could not be ${action === "cancel" ? "cancelled" : "deleted"}.`);
      await refresh(true);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Job could not be updated.");
      setPending((current) => { const next = { ...current }; delete next[id]; return next; });
    }
  };
  return { jobs, loadState, error, refreshedAt, pending, announcement, refresh, mutate };
}
