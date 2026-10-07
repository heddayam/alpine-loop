import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { JobHistoryPage, JobSnapshot } from "../model.js";
import { activeJob } from "./JobsDialog.js";
import { request } from "./request.js";

const HISTORY_SIZE = 50;
const compact = ({ inputs: _inputs, ...job }: JobSnapshot): JobSnapshot => job;
const unchanged = (previous: JobSnapshot, next: JobSnapshot) =>
  JSON.stringify(previous) === JSON.stringify(next) ? previous : next;

/** Keep active jobs and one recent terminal page; preserve unchanged snapshots. */
export function mergeJobs(
  current: JobSnapshot[],
  incoming: JobSnapshot[],
): JobSnapshot[] {
  const byId = new Map(current.map((job) => [job.id, job]));
  for (const full of incoming) {
    const next = compact(full);
    const previous = byId.get(next.id);
    byId.set(next.id, previous ? unchanged(previous, next) : next);
  }
  let terminal = 0;
  const next = [...byId.values()]
    .sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
    )
    .filter((job) => activeJob(job) || terminal++ < HISTORY_SIZE);
  return next.length === current.length && next.every((job, i) => job === current[i])
    ? current
    : next;
}

/** A disappearing active ID must be read: completion, failure and cancellation are all terminal. */
export async function pollActiveJobs(
  previousIds: ReadonlySet<string>,
  signal: AbortSignal,
  read = request<JobSnapshot | JobSnapshot[]>,
): Promise<JobSnapshot[]> {
  const active = await read("/api/jobs/active", signal) as JobSnapshot[];
  const activeIds = new Set(active.map((job) => job.id));
  const finished = await Promise.all(
    [...previousIds].filter((id) => !activeIds.has(id)).map(async (id) => {
      try {
        return await read(`/api/jobs/${encodeURIComponent(id)}?inputs=false`, signal) as JobSnapshot;
      } catch (failure) {
        if ((failure as { status?: number }).status === 404) return undefined;
        throw failure;
      }
    }),
  );
  return [...active, ...finished.filter((job): job is JobSnapshot => !!job)];
}

export function useJobs() {
  const [jobs, setJobs] = useState<JobSnapshot[]>([]);
  const [page, setPage] = useState<JobHistoryPage>({ jobs: [] });
  const [cursor, setCursor] = useState<string>();
  const previousCursors = useRef<(string | undefined)[]>([]);
  const [revision, setRevision] = useState(0);
  const [historyError, setHistoryError] = useState("");
  const [pollError, setPollError] = useState("");
  const [loading, setLoading] = useState(true);
  const activeIds = useRef(new Set<string>());
  const anyActive = jobs.some(activeJob);
  const upsert = useCallback((job: JobSnapshot) => {
    if (activeJob(job)) activeIds.current.add(job.id);
    setJobs((current) => mergeJobs(current, [job]));
    setPage((current) => {
      const rows = current.jobs.map((item) =>
        item.id === job.id ? unchanged(item, compact(job)) : item,
      );
      return rows.every((item, i) => item === current.jobs[i])
        ? current
        : { ...current, jobs: rows };
    });
  }, []);
  const remove = useCallback((id: string) => {
    activeIds.current.delete(id);
    setJobs((current) => current.filter((job) => job.id !== id));
    setPage((current) => ({
      ...current, jobs: current.jobs.filter((job) => job.id !== id),
    }));
  }, []);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void request<JobHistoryPage>(
      `/api/jobs/history${cursor ? `?before=${encodeURIComponent(cursor)}` : ""}`,
      controller.signal,
    )
      .then((next) => {
        if (controller.signal.aborted) return;
        for (const job of next.jobs) if (activeJob(job)) activeIds.current.add(job.id);
        setPage(next);
        if (!cursor) setJobs((current) => mergeJobs(current.filter(activeJob), next.jobs));
        setHistoryError("");
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setHistoryError(failure.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [cursor, revision]);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let inFlight = false;
    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      clearTimeout(timer);
      try {
        const previous = activeIds.current;
        const next = await pollActiveJobs(previous, controller.signal);
        if (controller.signal.aborted) return;
        const nextIds = new Set(next.filter(activeJob).map((job) => job.id));
        const deleted = new Set(
          [...previous].filter((id) => !next.some((job) => job.id === id)),
        );
        activeIds.current = nextIds;
        // Refresh the history cursor once a job leaves the queue, so the first page stays complete.
        if ([...previous].some((id) => !nextIds.has(id))) setRevision((value) => value + 1);
        setJobs((current) => mergeJobs(current.filter((job) => !deleted.has(job.id)), next));
        setPage((current) => {
          const updates = new Map(next.map((job) => [job.id, job]));
          const rows = current.jobs
            .filter((job) => !deleted.has(job.id))
            .map((job) => updates.has(job.id) ? unchanged(job, updates.get(job.id)!) : job);
          return rows.every((job, i) => job === current.jobs[i]) && rows.length === current.jobs.length
            ? current
            : { ...current, jobs: rows };
        });
        setPollError("");
      } catch (failure) {
        if (!controller.signal.aborted)
          setPollError(failure instanceof Error ? failure.message : "Jobs could not reconnect.");
      } finally {
        inFlight = false;
        if (!controller.signal.aborted)
          timer = setTimeout(() => void poll(), document.hidden || !activeIds.current.size ? 15000 : 1000);
      }
    };
    const visible = () => {
      if (!document.hidden) void poll();
    };
    document.addEventListener("visibilitychange", visible);
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [revision, anyActive]);

  const history = useMemo(() => {
    if (!cursor) return jobs;
    const updates = new Map(jobs.map((job) => [job.id, job]));
    return [
      ...jobs.filter((job) => activeJob(job) && !page.jobs.some((row) => row.id === job.id)),
      ...page.jobs.map((job) => updates.get(job.id) ?? job),
    ];
  }, [jobs, page, cursor]);
  return {
    jobs, history, loading, error: historyError || pollError, upsert, remove, refresh,
    hasOlder: !!page.nextCursor, hasNewer: previousCursors.current.length > 0,
    older: () => {
      if (loading || !page.nextCursor) return;
      previousCursors.current.push(cursor);
      setCursor(page.nextCursor);
    },
    newer: () => {
      if (loading || !previousCursors.current.length) return;
      setCursor(previousCursors.current.pop());
    },
  };
}
